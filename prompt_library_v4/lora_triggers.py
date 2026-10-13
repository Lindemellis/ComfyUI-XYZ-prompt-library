"""Recognise trigger bundles without flattening alternative prompt combinations."""
from __future__ import annotations

import hashlib
import json
import re

from ._v3 import PLv3Error, render
from .model import CommandError, EditorState

if '.' in __package__:
    from ..prompt_shared.language.lexer import CLOSERS, COMMA, TEXT, tokenize
else:
    from prompt_shared.language.lexer import CLOSERS, COMMA, TEXT, tokenize


def split_bundles(text):
    """Only empty top-level comma items separate bundles; literals stay opaque."""
    result, stack, start, previous_comma = [], [], 0, None
    for token in tokenize(text):
        if token.kind in CLOSERS:
            stack.append(CLOSERS[token.kind])
        elif stack and token.kind == stack[-1]:
            stack.pop()
        elif not stack and token.kind == COMMA:
            if previous_comma is not None:
                piece = text[start:previous_comma].strip()
                if piece: result.append(piece)
                start = token.pos + 1
            previous_comma = token.pos
            continue
        if token.kind != TEXT or token.raw.strip(): previous_comma = None
    tail = text[start:].strip()
    if tail: result.append(tail)
    return result


def trigger_nodes(text):
    """Keep malformed/structural external metadata as literal editable text."""
    try:
        parsed = EditorState.create(text=text); parsed.check()
        if any(item.kind == 'group' and item.form != 'paren' for item in parsed.doc.root.children):
            raise CommandError('invalid_tag', '触发词必须是文字')
    except (CommandError, PLv3Error):
        parsed = EditorState.create(text=json.dumps(text, ensure_ascii=False)); parsed.check()
    # Same identity as AssetLibrary.tag_key, including attention and punctuation.
    unique = {}
    for item in parsed.doc.root.children:
        item.enabled = True; item.sep = ''
        unique.setdefault(render(item).strip(), item)
    return unique


def bundle_name(keys, index, source=''):
    # A source-authored character/caption heading is more specific than outfit
    # vocabulary. It only names the Folder; prompt wording is never rewritten.
    label_source = source.strip()
    first_node = next(iter(keys.values()), None) if isinstance(keys, dict) else None
    if first_node and first_node.form == 'paren' and first_node.children:
        label_source = render(first_node.children[0]).strip()
    heading = re.match(r'^(.{1,100}?)\s+(?:with|is|features|has|wearing|wears|dressed)\b', label_source, re.I)
    first = label_source.split(',', 1)[0].strip() if label_source else next(iter(keys), '')
    candidate = heading.group(1) if heading else first
    generic = {'a', 'an', 'the', 'girl', 'boy', 'woman', 'man', 'solo', 'portrait', 'photo', 'image', 'black', 'white', 'red', 'blue', 'green', 'long', 'short'}
    parts = candidate.split()
    if (parts and len(parts) <= 6 and not any(part.casefold() in generic for part in parts)
            and (len(keys) == 1 or any(char.isupper() or char.isdigit() or ord(char) > 127 for char in candidate))
            and not candidate.startswith(('"', '<', '(', '{', '[')) and not re.match(r'^\d+[a-z_]+$', candidate, re.I)):
        return ''.join('_' if char in '[]\\\n\r' else char for char in candidate).lstrip('@').strip() or f'组合 {index}'
    tags = {key.casefold().replace('_', ' ') for key in keys}
    for name, cues in (
        ('女仆装', {'maid dress', 'maid apron', 'maid headdress'}),
        ('兔女郎装', {'playboy bunny', 'bunny suit', 'bunnysuit'}),
        ('泳装', {'swimsuit', 'bikini', 'one-piece swimsuit'}),
        ('校服', {'school uniform', 'serafuku'}),
        ('日常装', {'sweater', 'white sweater', 'hoodie', 't-shirt', 'jeans'}),
    ):
        if tags & cues: return name
    return f'组合 {index}'


def trigger_groups(words):
    """Keep trainedWords entries as combinations before parsing their contents.

    Civitai/sidecar arrays already carry authored boundaries: different characters
    need not share any exact tags. Arrays containing only atomic tags stay flat.
    Legacy `,,` strings remain a fallback, never a prerequisite for grouping.
    """
    pieces, explicit = [], False
    if isinstance(words, str): words = [words]
    for word in words if isinstance(words, list) else []:
        if not isinstance(word, str) or not word.strip(): continue
        split = split_bundles(word)
        explicit |= len(split) > 1
        pieces.extend((piece, trigger_nodes(piece)) for piece in split)
    composite = any(len(nodes) > 1 or len(source.split()) >= 8
                    or any(len([part for part in node.walk() if part.kind != 'group']) > 1 for node in nodes.values())
                    for source, nodes in pieces)
    if len(pieces) < 2 or not (explicit or composite):
        return [{'key': None, 'name': None, 'nodes': {key: node for _, nodes in pieces for key, node in nodes.items()}}]
    result, seen = [], set()
    for source, piece in pieces:
        if not piece: continue
        key = hashlib.sha256(json.dumps(sorted(piece), ensure_ascii=False).encode()).hexdigest()
        if key in seen: continue
        seen.add(key)
        result.append({'key': key, 'name': bundle_name(piece, len(result) + 1, source), 'nodes': piece})
    return result
