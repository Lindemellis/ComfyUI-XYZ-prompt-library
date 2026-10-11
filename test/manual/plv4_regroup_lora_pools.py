"""Explicitly repair existing flat LoRA pools through the running single writer.

Default is read-only planning. --apply requires a new snapshot file; source
metadata and model files are never written. Existing grouped pools are skipped.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from prompt_library_v4.lora_triggers import trigger_groups


def post(base, path, body):
    request = Request(base.rstrip('/') + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=25) as response: result = json.load(response)
    if not result.get('ok'): raise RuntimeError(result.get('error', 'Request failed'))
    return result


def regroup(base, apply=False, snapshot=None):
    assets = post(base, '/xyz/plv4/library/read', {'action': 'tree'})['assets']
    plans = []
    for pool in assets:
        if not pool.get('lora_root'): continue
        children = [asset for asset in assets if asset['parent_id'] == pool['id']]
        if any(post(base, '/xyz/plv4/library/read', {'action': 'get', 'id': child['id']})['data'].get('lora_trigger_group') for child in children if child['kind'] == 'folder'): continue
        keys = {child['name'] for child in children if child['kind'] == 'tag'}
        if not keys: continue
        current = post(base, '/xyz/plv4/library/read', {'action': 'get', 'id': pool['id']})
        info = post(base, '/xyz/plv4/loras/detail', {'id': current['data']['lora']['id']})
        groups = [group for group in trigger_groups(info['triggers']) if group['key'] and keys.intersection(group['nodes'])]
        if len(groups) < 2: continue
        plans.append({'pool_id': pool['id'], 'name': pool['name'], 'groups': [group['name'] for group in groups],
                      'body': {'action': 'ensure_lora', 'lora': {key: info[key] for key in ('id', 'name', 'relative', 'root_id')}, 'triggers': info['triggers'], 'regroup_existing': True}})
    if apply and plans:
        if snapshot is None: raise ValueError('--apply requires --snapshot pointing to a new file')
        # Capture complete current rows before the first write; preserve IDs and
        # disabled snapshots for review/recovery rather than copying an open DB.
        snapshot = Path(snapshot); snapshot.parent.mkdir(parents=True, exist_ok=True)
        saved = [post(base, '/xyz/plv4/library/read', {'action': 'get', 'id': asset['id']}) for asset in assets if '/' not in asset['id']]
        with snapshot.open('x', encoding='utf-8') as handle:
            json.dump({'created': datetime.now(timezone.utc).isoformat(), 'assets': saved, 'plans': plans}, handle, ensure_ascii=False, indent=2)
        for plan in plans: post(base, '/xyz/plv4/library/mutate', plan['body'])
    return {'applied': apply, 'pools': [{key: value for key, value in plan.items() if key != 'body'} for plan in plans], 'snapshot': str(snapshot) if apply and plans else None}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:8190')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--snapshot', type=Path)
    args = parser.parse_args()
    print(json.dumps(regroup(args.base_url, args.apply, args.snapshot), ensure_ascii=False, indent=2))
