"""Build a fresh Folder/Class/Block acceptance Library, never overwrite a DB.

Installation into the persistent test instance is a separate, explicitly
authorized step with the instance stopped and its previous Library backed up.
Optional LoRA records come from the running browser's read-only model index.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from prompt_library_v4.assets import AssetLibrary, renumber
from prompt_library_v4.model import EditorState
from prompt_library_v4._v3 import DocNode
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.commands import apply_command


def append_lora_sample(samples, loras):
    if not loras: return
    state = EditorState.create(text='1girl, solo')
    for item in loras:
        state = apply_command(state, {'type':'InsertLora', 'revision':state.revision,
                                     'lora':item, 'pool_id':item['pool_id']})
    for mode in ('couple','mask'):
        for seed in (0,42): compile_document(state,seed=seed,region_mode=mode)
    samples.append({'title':'05-LoRA固定Class-隐藏Library','text':state.text,'doc':state.doc.to_json()})


def build(path, loras=()):
    path = Path(path).resolve()
    if path.exists():
        raise ValueError('A new, nonexistent target database is required')
    library = AssetLibrary(path)
    keys = {}
    checks = []
    try:
        def asset(key, kind, name, parent=None, **fields):
            value = library.mutate({'action': 'save_' + kind, 'name': name,
                                    'parent_id': keys.get(parent), **fields})['asset']
            keys[key] = value['id']
            return value

        def pool(key, name, parent, tags, autocomplete=True):
            asset(key, 'class', name, parent, data={'autocomplete': autocomplete})
            for text in tags:
                library.mutate({'action': 'save_tag', 'text': text, 'parent_id': keys[key]})

        def node(text, name=None, binding=None):
            value = EditorState.create(text=text).doc.root.children[0]
            if name: value.meta['name'] = name
            if binding: value.meta['pool'] = keys[binding]
            return value

        def block(key, name, parent, value):
            return asset(key, 'block', name, parent, snapshot=value.to_json())

        def document(block_keys):
            doc = EditorState.create(text='').doc
            doc.root.children = [DocNode.from_json(library.read('expand', id=keys[key])['snapshot']) for key in block_keys]
            for index, value in enumerate(doc.root.children):
                value.sep = ',\n' if index < len(doc.root.children)-1 else ''
            renumber(doc.root)
            doc.next_id = len(list(doc.root.walk())) + 1
            doc.root.meta['compiler'] = 'plv4'
            return EditorState.create(doc=doc.to_json())

        asset('artist_folder', 'folder', 'artist')
        pool('artist_class', 'artist', 'artist_folder', ['ciloranko', 'torino_aqua'])
        pool('azure_class', 'azurlane', 'artist_class', ['atdan', 'ask_(askzy)'])
        pool('paint_class', '厚涂', 'artist_class', ['wlop', 'painterly', 'brush strokes'])
        asset('anima_folder', 'folder', 'anima', 'artist_folder')
        asset('illustrious_folder', 'folder', 'illustrious', 'artist_folder')
        anima1 = node('{ ciloranko, { atdan, ask_(askzy) }, { soft lighting } }', 'anima1', 'artist_class')
        anima1.children[1].meta.update(name='anima1.azurlane', pool=keys['azure_class'])
        anima1.children[1].children[1].enabled = False
        anima1.children[2].meta['name'] = '未绑定子块'
        block('anima1', 'anima1', 'anima_folder', anima1)
        anima2 = node('{ torino_aqua, { wlop, painterly } }', 'anima2', 'artist_class')
        anima2.children[1].meta.update(name='厚涂组合', pool=keys['paint_class'])
        block('anima2', 'anima2', 'anima_folder', anima2)
        block('illustrious1', 'illustrious1', 'illustrious_folder', node('{ ciloranko, torino_aqua }', binding='artist_class'))
        block('azure_saved', 'azurlane独立组合', 'illustrious_folder', node('{ atdan, ask_(askzy) }', binding='azure_class'))
        block('paint_saved', '厚涂独立组合', 'illustrious_folder', node('{ wlop, brush strokes }', binding='paint_class'))
        block('unbound', '未绑定对照', 'anima_folder', node('{ anime coloring, clean lineart }'))

        asset('wardrobe_folder', 'folder', '服装')
        pool('wardrobe_class', '服装', 'wardrobe_folder', ['hair ornament'])
        pool('uniform_class', '制服', 'wardrobe_class', ['white shirt', 'pleated skirt', 'necktie'])
        pool('casual_class', '休闲', 'wardrobe_class', ['white shirt', 'jeans', 'sneakers'], autocomplete=False)
        asset('wardrobe_blocks', 'folder', '组合', 'wardrobe_folder')
        uniform = node('{ white shirt, pleated skirt, necktie }', binding='uniform_class')
        uniform.children[-1].enabled = False
        block('uniform', '制服组合-保留关闭项', 'wardrobe_blocks', uniform)
        block('casual', '休闲组合', 'wardrobe_blocks', node('{ white shirt, jeans, sneakers }', binding='casual_class'))

        asset('scene_folder', 'folder', '场景')
        pool('scene_class', '场景', 'scene_folder', ['indoors', 'outdoors'])
        pool('light_class', '光线', 'scene_class', ['soft lighting', 'backlighting', 'sunlight'])
        asset('scene_blocks', 'folder', '组合', 'scene_folder')
        light = node('{ outdoors, { sunlight, backlighting } }', binding='scene_class')
        light.children[1].meta.update(name='独立光线', pool=keys['light_class'])
        block('scene', '室外与独立光线', 'scene_blocks', light)
        block('light', '柔光组合', 'scene_blocks', node('{ soft lighting, backlighting }', binding='light_class'))

        asset('full_folder', 'folder', 'full prompt')
        full = node('{ 1girl, solo, { ciloranko }, { white shirt }, { outdoors } }')
        for index, source in [(2, 'anima1'), (3, 'uniform'), (4, 'scene')]:
            full.children[index] = DocNode.from_json(library.read('expand', id=keys[source])['snapshot'])
            full.children[index].sep = ', ' if index < 4 else ''
        renumber(full)
        block('full', '完整组合-独立子池', 'full_folder', full)
        block('full_unbound', '完整组合-无绑定对照', 'full_folder', node('{ 1girl, solo, blue eyes, long hair, outdoors }'))

        asset('special_folder', 'folder', '结构测试')
        block('schedule', 'Schedule-两阶段', 'special_folder', node('[@schedule]: { 0 - 0.4: { closed eyes }, 0.4 - 1: { open eyes } }'))
        block('region', 'Region-base与mask', 'special_folder', node('[@region]: { [base]: { scenery }, [mask: [0, 0.5, 0, 1]]: { 1girl } }'))
        block('avg', 'AVG-两组相对权重', 'special_folder', node('[@avg]: { 1: { watercolor }, 2: { oil painting } }'))
        asset('empty_folder', 'folder', '空 Folder-添加整理项', 'special_folder')
        pool('empty_class', '空 Class-绑定收录', 'special_folder', [], autocomplete=False)

        lora_examples = []
        for item in loras:
            identity = {key:item[key] for key in ('id', 'name', 'relative', 'root_id')}
            created = library.mutate({'action': 'ensure_lora', 'lora': identity, 'triggers': item.get('triggers', [])})
            root = library.read('get', id=created['id'])
            # Manual test variations are kept separate from the model's original triggers.
            for name, tags in [('测试-默认', ['simple background', 'standing']), ('测试-近景', ['upper body', 'looking at viewer'])]:
                child = library.mutate({'action':'save_class','name':name,'parent_id':root['id']})['asset']
                for text in tags: library.mutate({'action':'save_tag','parent_id':child['id'],'text':text})
            lora_examples.append({**identity, 'pool_id':root['id']})

        tree = library.read()
        assert not tree['legacy_pools']
        entries = {row['id']:row for row in tree['assets']}
        candidate_tree = library.read('candidates', pool=keys['artist_class'])['candidates']
        def descendants(rows):
            for row in rows:
                yield row
                yield from descendants(row.get('children', []))
        candidates = list(descendants(candidate_tree))
        candidate_blocks = {row['id'] for row in candidates if row['kind'] == 'block'}
        assert {keys[k] for k in ('anima1','anima2','illustrious1','azure_saved','paint_saved')} <= candidate_blocks
        assert keys['unbound'] not in candidate_blocks
        assert not any('/' in row['id'] for row in candidates if row['kind']=='block')
        checks.append('跨 Folder 绑定及 Subclass 反向候选，未绑定/内嵌子块排除')
        assert len([a for a in tree['assets'] if a['kind']=='tag' and a['name']=='white shirt']) == 2
        checks.append('兄弟 Class 可保留同名 prompt')
        samples = []
        for title, selected in [('01-artist父池与独立子池',['anima1']), ('02-跨Folder组合与关闭项',['illustrious1','uniform']), ('03-完整prompt',['full']), ('04-Schedule-Region-AVG',['schedule','region','avg'])]:
            state = document(selected)
            for mode in ('couple','mask'):
                for seed in (0,42): compile_document(state,seed=seed,region_mode=mode)
            samples.append({'title':title,'text':state.text,'doc':state.doc.to_json()})
        append_lora_sample(samples, lora_examples)
        checks.append(f'{len(samples)}组文档 × 2 seed × 2 backend 编译通过')
        for value in lora_examples:
            assert entries[value['pool_id']]['kind']=='class' and entries[value['pool_id']]['library_hidden']
            pool_tree = library.read('candidates',pool=value['pool_id'])['candidates']
            assert all(entries[row['id']]['library_hidden'] for row in descendants(pool_tree) if row['kind'] in ('class','tag'))
        checks.append('LoRA固定关联Class；整个触发词子树标记为Library隐藏')
        counts = {}
        for value in tree['assets']:
            if not value.get('owner_id'): counts[value['kind']] = counts.get(value['kind'],0)+1
        result = {'schema':'Folder/Class/Block','database':str(path),'key_assets':keys,'counts':counts,
                  'assets':tree['assets'],'samples':samples,'loras':lora_examples,'checks':checks}
    finally:
        library.close()
    with sqlite3.connect(path) as conn:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    return result


def workflow(template, manifest):
    """Create a separate acceptance workflow; never change an existing one."""
    source = next(n for n in template['nodes'] if n['type']=='XYZ Prompt Library V4')
    nodes = []
    for index, sample in enumerate(manifest['samples'],1):
        value = deepcopy(source)
        value.update(id=index,title=sample['title'],pos=[60+(index-1)%2*550,80+(index-1)//2*400],order=index-1)
        value['widgets_values']=[sample['text'],42,'fixed','couple',json.dumps(sample['doc'],ensure_ascii=False)]
        value['properties']={'Node name for S&R':'XYZ Prompt Library V4'}
        for port in value.get('inputs',[]):port['link']=None
        for port in value.get('outputs',[]):port['links']=None
        nodes.append(value)
    return {'last_node_id':len(nodes),'last_link_id':0,'nodes':nodes,'links':[],'groups':[],
            'config':{},'extra':{},'version':0.4}


def update_workflow(template, manifest):
    """Refresh existing acceptance nodes while keeping their IDs and wiring."""
    graph = deepcopy(template)
    nodes = [n for n in graph['nodes'] if n['type'] in ('XYZ Prompt Library V4','XYZ Prompt Library V4 Monaco')]
    if len(nodes) < 4 or len(nodes) > len(manifest['samples']): raise ValueError('Unexpected number of acceptance nodes')
    # Historical workflows put the Monaco Schedule example before full prompt.
    indices = [0,1,3,2,*range(4,len(manifest['samples']))] if any(n['type'].endswith('Monaco') for n in nodes) else list(range(len(manifest['samples'])))
    while len(nodes)<len(manifest['samples']):
        added = deepcopy(nodes[0])
        added['id'] = max(n['id'] for n in graph['nodes'])+1
        added['pos'] = [nodes[0]['pos'][0],max(n['pos'][1]+n.get('size',[500,460])[1] for n in graph['nodes'])+80]
        added['order'] = len(graph['nodes'])
        for port in added.get('inputs',[]):port['link']=None
        for port in added.get('outputs',[]):port['links']=None
        graph['nodes'].append(added);nodes.append(added)
    for node,index in zip(nodes,indices):
        sample=manifest['samples'][index]
        node['title']=sample['title']
        current=node.get('widgets_values',[])
        seed=current[1] if len(current)>1 and isinstance(current[1],int) else 42
        node['widgets_values']=[sample['text'],seed,'fixed','couple',json.dumps(sample['doc'],ensure_ascii=False)]
        node.setdefault('properties',{}).pop('doc',None)
        node['properties'].pop('text',None)
        node['properties']['Node name for S&R']=node['type']
    seed = next((n for n in graph['nodes'] if n['type']=='PrimitiveNode' and 'seed' in n.get('title','').lower()),None)
    for added in nodes[4:]:
        target=next((i for i,p in enumerate(added.get('inputs',[])) if p['name']=='seed'),None)
        if seed and target is not None and added['inputs'][target].get('link') is None:
            link_id=max([graph.get('last_link_id',0),*[link[0] for link in graph.get('links',[])]])+1
            graph.setdefault('links',[]).append([link_id,seed['id'],0,added['id'],target,'INT'])
            added['inputs'][target]['link']=link_id
            seed['outputs'][0]['links']=(seed['outputs'][0].get('links') or [])+[link_id]
    instructions='''Folder / Class / Block 测试
1. artist Folder 收纳 Class 和组合 Folder；只有 Class 提供 prompt 池。
2. anima1 绑定 artist Class，azurlane 子块独立绑定 Subclass；开关、撤销保留关闭项。
3. 同一 Pool 会列出其他 Folder 里绑定同一 Class 的已保存 Block，来源自身除外。
4. Monaco 节点测试 Schedule / Region / AVG；完整 prompt 保留各子块独立池。
5. LoRA 节点固定绑定 Class；从 LoRA 浏览器编辑触发词和 Subclass，普通 Library 不显示 LoRA 项。
已打开的旧画布须重新打开这个工作流，才会加载更新后的节点。'''
    for note in graph['nodes']:
        if note['type'] in ('MarkdownNote','Note') and note.get('widgets_values'):
            note['widgets_values'][0]=instructions
    graph['last_node_id']=max([graph.get('last_node_id',0),*[n['id'] for n in graph['nodes']]])
    graph['last_link_id']=max([graph.get('last_link_id',0),*[link[0] for link in graph.get('links',[])]])
    return graph


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database',type=Path)
    parser.add_argument('--loras',type=Path)
    parser.add_argument('--manifest',required=True,type=Path)
    args=parser.parse_args()
    if args.manifest.exists():raise ValueError('Manifest already exists')
    records=json.loads(args.loras.read_text(encoding='utf-8')) if args.loras else []
    result=build(args.database,records)
    args.manifest.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'counts':result['counts'],'checks':result['checks']},ensure_ascii=False))
