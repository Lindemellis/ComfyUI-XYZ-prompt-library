"""Stage only the two approved V3 imports, then install with ComfyUI stopped.

Uses current test asset placement and data, but excludes test examples. A fresh
Library is built with the canonical schema and single writer, never by copying
the test database. Installation retains the previous formal DB and WAL files.
"""
import argparse
from collections import Counter
from dataclasses import dataclass
import json
from pathlib import Path
import socket
import subprocess

from import_xyz_artist_library import backup, dump, logical_digest, readonly, state_for
from prompt_library_v4.assets import AssetLibrary, bump, loose_check, names_check, validate_snapshot
from prompt_library_v4.hierarchy import placement_check
from prompt_library_v4.compiler import compile_document

REPO=Path(__file__).resolve().parents[2]
INSTALL=REPO.parents[2]
FORMAL=REPO/'prompt_library_v4_data/plv4-pools.db'
TEST=INSTALL/'XYZNodes-Test/custom_nodes/ComfyUI-XYZNodes/prompt_library_v4_data/plv4-pools.db'
V3=REPO/'prompt_library_v3_data/plv3.db'
IMPORTS=[INSTALL/'.codex-backups/xyz-artist-v3-import-20261012T100218Z/live-journal.json',INSTALL/'.codex-backups/xyz-v3-remaining-import-20261012T103925Z/live-journal.json']


def formal_stopped():
    with socket.socket() as sock:
        sock.settimeout(1)
        if sock.connect_ex(('127.0.0.1',8188))==0:
            raise RuntimeError('Formal ComfyUI is running; do not replace its open database')
    script=r"Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" | Where-Object { $_.CommandLine -match 'ComfyUI.+main.py' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    # Pass literal PowerShell source directly, not shell interpolation.
    script=script.replace(r'\"','"')
    reply=subprocess.run(['powershell','-NoProfile','-Command',script],capture_output=True,text=True,check=True)
    processes=json.loads(reply.stdout) if reply.stdout.strip() else []
    if isinstance(processes,dict):processes=[processes]
    for process in processes:
        command=process.get('CommandLine') or ''
        if 'XYZNodes-Test' not in command and 'plv4_fixture' not in command and 'xyz-plv4-' not in command:
            raise RuntimeError(f'Potential regular ComfyUI process {process["ProcessId"]} must be stopped before installation')


@dataclass
class Populate:
    records:list
    def apply(self,conn):
        if conn.execute('SELECT COUNT(*) FROM assets').fetchone()[0]:
            raise ValueError('Only a new empty target Library may be populated')
        conn.execute('PRAGMA defer_foreign_keys=ON')
        for row in self.records:
            conn.execute('INSERT INTO assets(id,kind,name,parent_id,position,version,data_json) VALUES(?,?,?,?,?,?,?)',tuple(row[k] for k in ('id','kind','name','parent_id','position','version','data_json')))
        placement_check(conn);names_check(conn);loose_check(conn)
        for row in self.records:
            if row['kind']=='block':validate_snapshot(json.loads(row['data_json'])['snapshot'])
        if conn.execute('PRAGMA foreign_key_check').fetchone():raise ValueError('Dangling Library relationship')
        bump(conn)
        return dict(Counter(row['kind'] for row in self.records))


def prepare(output):
    formal_stopped()
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    backup(FORMAL,output/'formal-before.db');backup(TEST,output/'test-source.db')
    digests={'formal':logical_digest(FORMAL),'test':logical_digest(TEST),'v3':logical_digest(V3)}
    selected=set()
    for path in IMPORTS:
        for entry in json.loads(path.read_text(encoding='utf-8')):
            if entry['request']['action'].startswith('save_'):selected.add(entry['id'])
    conn=readonly(output/'test-source.db')
    try:all_rows={row['id']:dict(row) for row in conn.execute('SELECT * FROM assets')}
    finally:conn.close()
    if selected-set(all_rows):raise ValueError('Imported asset was deleted; inspect selection before publishing')
    # Include any user additions inside an imported Class/Folder, while never
    # selecting the existing sample assets saved before either import.
    baseline=readonly(IMPORTS[0].parent/'test-before.db')
    try:known_samples={row['id'] for row in baseline.execute('SELECT id FROM assets')}
    finally:baseline.close()
    changed=True
    while changed:
        changed=False
        for row in all_rows.values():
            if row['parent_id'] in selected and row['id'] not in selected and row['id'] not in known_samples:
                selected.add(row['id']);changed=True
    records=sorted((all_rows[key] for key in selected),key=lambda row:(row['position'],row['id']))
    for row in records:
        if row['parent_id'] and row['parent_id'] not in selected:raise ValueError('Imported asset has a parent outside the approved selection')
        data=json.loads(row['data_json'])
        if data.get('lora'):raise ValueError('A test LoRA Class entered the selection')
        def check(node):
            meta=node.get('meta',{})
            if meta.get('pool') and meta['pool'] not in selected:raise ValueError('Pool binding points outside the approved selection')
            if meta.get('lora'):raise ValueError('A test LoRA Block entered the selection')
            for child in node.get('children',[]):check(child)
        if 'snapshot' in data:check(data['snapshot'])
    target=output/'formal-new.db'
    if target.exists():raise ValueError('Staging target already exists')
    library=AssetLibrary(target)
    try:
        counts=library.writer.enqueue(Populate(records)).result()
        comparisons=0
        for row in records:
            if row['kind']!='block':continue
            before=state_for(json.loads(row['data_json'])['snapshot'])
            after=state_for(library.read('expand',id=row['id'])['snapshot'])
            for seed in (0,42):
                for mode in ('couple','mask'):
                    first=compile_document(before,seed=seed,region_mode=mode)
                    second=compile_document(after,seed=seed,region_mode=mode)
                    for key in ('prompt','plain'):
                        assert first[key]==second[key],(row['name'],seed,mode,key)
                        comparisons+=1
    finally:library.close()
    conn=readonly(target)
    try:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not list(conn.execute('PRAGMA foreign_key_check'))
        copied={r['id']:dict(r) for r in conn.execute('SELECT * FROM assets')}
        assert copied=={row['id']:row for row in records}
        roots=[{'id':r['id'],'name':r['name'],'kind':r['kind']} for r in records if r['parent_id'] is None]
        assert {r['name'] for r in roots}=={'artist','plv3','copyright'}
    finally:conn.close()
    report={'counts':counts,'roots':roots,'selected_ids':sorted(selected),'excluded_sample_assets':len(all_rows)-len(records),'block_output_comparisons':comparisons,'digests_before':digests,'staged_digest':logical_digest(target),'target':str(FORMAL)}
    dump(output/'selection.json',records);dump(output/'preflight.json',report)
    print(json.dumps({key:value for key,value in report.items() if key not in ('selected_ids','digests_before','staged_digest')},ensure_ascii=False))


def install(output):
    output=Path(output).resolve()
    report=json.loads((output/'preflight.json').read_text(encoding='utf-8'))
    if (output/'installed.json').exists():raise ValueError('This staged Library was already installed')
    formal_stopped()
    assert logical_digest(FORMAL)==report['digests_before']['formal'],'Formal Library changed after backup'
    assert logical_digest(TEST)==report['digests_before']['test'],'Reviewed test content changed after staging'
    assert logical_digest(V3)==report['digests_before']['v3'],'V3 source changed after staging'
    target=output/'formal-new.db'
    assert logical_digest(target)==report['staged_digest']
    formal_dir=FORMAL.parent.resolve()
    assert FORMAL.resolve().parent==formal_dir and formal_dir==REPO/'prompt_library_v4_data'
    assert output.is_relative_to(INSTALL/'.codex-backups')
    journal=[]
    try:
        for suffix in ('-wal','-shm',''):
            source=Path(str(FORMAL)+suffix)
            if source.exists():
                destination=output/('retired-plv4-pools.db'+suffix)
                if destination.exists():raise ValueError('Retired-file destination already exists')
                source.rename(destination);journal.append((source,destination))
        # Install the freshly built, validated subset, never the source test DB.
        import shutil
        shutil.copy2(target,FORMAL)
        assert logical_digest(FORMAL)==report['staged_digest']
    except BaseException:
        if FORMAL.exists() and any(source==FORMAL for source,_ in journal):FORMAL.unlink()
        for source,destination in reversed(journal):destination.rename(source)
        raise
    assert logical_digest(TEST)==report['digests_before']['test']
    assert logical_digest(V3)==report['digests_before']['v3']
    dump(output/'installed.json',{'formal':str(FORMAL),'digest':logical_digest(FORMAL),'test_unchanged':True,'v3_unchanged':True,'roots':report['roots'],'counts':report['counts'],'excluded_sample_assets':report['excluded_sample_assets'],'comparisons':report['block_output_comparisons']})
    print('Installed approved V3 import subset; previous formal Library preserved in backup.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['prepare','install']);parser.add_argument('output',type=Path)
    args=parser.parse_args()
    prepare(args.output) if args.command=='prepare' else install(args.output)
