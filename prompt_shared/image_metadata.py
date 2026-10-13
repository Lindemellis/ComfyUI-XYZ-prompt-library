"""Versioned, Library-independent PLV4 image snapshots and parameters transport."""
from __future__ import annotations

import base64
import binascii
from collections import Counter
from copy import deepcopy
import json
import math
import re

PROMPT_SCHEMA = 'xyz.plv4.prompt-metadata'
IMAGE_SCHEMA = 'xyz.plv4.image-metadata'
PARAMETER_KEY = 'XYZ PLV4'
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_ENCODED_BYTES = (MAX_JSON_BYTES * 4 + 2) // 3
PARAMETER_RE = re.compile(r'(?:^|,\s*)XYZ PLV4:\s*(v\d+\.[A-Za-z0-9_-]+)(?=\s*(?:,|$))')
_LORA = re.compile(r'^<lora:([^:<>]+)(?::([-+\d.eE]+))?(?::([-+\d.eE]+))?>$')


def lora_records(calls):
    records = []
    for token, interval in calls:
        match = _LORA.fullmatch(token)
        record = dict(raw=token, schedule=list(interval))
        if match:
            model = float(match[2]) if match[2] is not None else 1.0
            clip = float(match[3]) if match[3] is not None else model
            if not math.isfinite(model) or not math.isfinite(clip):
                raise ValueError('LoRA strengths must be finite')
            record.update(name=match[1], model_strength=model, clip_strength=clip)
        records.append(record)
    return records


def _check_loras(value):
    if not isinstance(value, list) or len(value) > 10000:
        raise ValueError('PLV4 LoRA records must be a bounded list')
    for row in value:
        if not isinstance(row, dict) or not isinstance(row.get('raw'), str):
            raise ValueError('Invalid PLV4 LoRA record')
        interval = row.get('schedule')
        if not isinstance(interval, list) or len(interval) != 2 or not all(
            type(v) in (int, float) and math.isfinite(v) for v in interval
        ) or not 0 <= interval[0] <= interval[1] <= 1:
            raise ValueError('Invalid PLV4 LoRA schedule')
        for key in ('model_strength', 'clip_strength'):
            if key in row and (type(row[key]) not in (int, float) or not math.isfinite(row[key])):
                raise ValueError('Invalid PLV4 LoRA strength')


def check_prompt(value, *, node_snapshot=True):
    if not isinstance(value, dict) or value.get('schema') != PROMPT_SCHEMA or value.get('version') != 1:
        raise ValueError('Unsupported PLV4 prompt metadata')
    if not all(isinstance(value.get(key), str) for key in ('source', 'prompt', 'plain', 'seed')):
        raise ValueError('PLV4 metadata is missing prompt text or seed')
    if value.get('region_mode') not in ('couple', 'mask') or value.get('compiler_policy') != 'plv4':
        raise ValueError('Invalid PLV4 compiler policy')
    doc = value.get('document')
    if not isinstance(doc, dict) or doc.get('version') != 2 or not isinstance(doc.get('root'), dict):
        raise ValueError('PLV4 metadata requires a Document v2 snapshot')
    if node_snapshot:
        for key in ('prompt_loras', 'plain_loras'):
            _check_loras(value.get(key))
    elif value.get('selected_output') not in ('prompt', 'plain'):
        raise ValueError('Invalid PLV4 selected output')
    return value


def check_image(value):
    if not isinstance(value, dict) or value.get('schema') != IMAGE_SCHEMA or value.get('version') != 1:
        raise ValueError('Unsupported PLV4 image metadata')
    check_prompt(value.get('positive'), node_snapshot=False)
    if value.get('negative') is not None:
        check_prompt(value['negative'], node_snapshot=False)
    if not isinstance(value.get('extra_lora_syntax'), str):
        raise ValueError('Invalid additional LoRA syntax')
    _check_loras(value.get('loras'))
    return value


def image_snapshot(value):
    check_image(value)
    return {key: deepcopy(value[key]) for key in (
        'schema', 'version', 'positive', 'negative', 'extra_lora_syntax', 'loras')}


def encode_parameters(value):
    raw = json.dumps(image_snapshot(value), ensure_ascii=False,
                     allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError('PLV4 image metadata exceeds 8 MiB')
    return f'{PARAMETER_KEY}: v1.' + base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def decode_parameters(parameters):
    # Only the final parameters line carries metadata; never inspect Source.
    tail = str(parameters or '').rsplit('\n', 1)[-1]
    matches = list(PARAMETER_RE.finditer(tail))
    if not matches:
        if 'XYZ PLV4:' in tail:
            raise ValueError('Malformed XYZ PLV4 parameters field')
        return None
    if len(matches) != 1:
        raise ValueError('Duplicate XYZ PLV4 parameters field')
    version, encoded = matches[0][1].split('.', 1)
    if version != 'v1' or len(encoded) > MAX_ENCODED_BYTES:
        raise ValueError('Unsupported or oversized XYZ PLV4 parameters field')
    try:
        raw = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError('PLV4 image metadata exceeds 8 MiB')
        return image_snapshot(json.loads(raw))
    except (binascii.Error, UnicodeError, RecursionError) as exc:
        raise ValueError('Invalid XYZ PLV4 parameters encoding') from exc


def selected_text(snapshot):
    return snapshot[snapshot['selected_output']] if snapshot is not None else ''


def merge_loras(positive, extra):
    # Consume one matching occurrence per source; explicit internal duplicates survive.
    def key(row):
        identity = (row['name'], row['model_strength'], row['clip_strength']) if 'name' in row else row['raw']
        return identity, tuple(row['schedule'])
    remaining = Counter(key(row) for row in positive)
    result = deepcopy(positive)
    for row in extra:
        if remaining[key(row)]:
            remaining[key(row)] -= 1
        else:
            result.append(deepcopy(row))
    return result
