"""Convert the isolated acceptance samples offline; originals are never replaced.

This replaces the retired HTTP Class seed script. It does not seed/reset a live
server, modify personal data, or overwrite existing converted samples.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.migrate_v4 import convert, convert_workflow
from prompt_library_v4._v3 import Document, render

ROOT=Path(__file__).resolve().parents[5]/'XYZNodes-Test'

LABELS = {
    '空白Class': '空白池',
    '拖入 Class 的目标': '拖入 Folder 绑定池',
    '已加载人物候选': '人物候选子 block',
    '03-循环引用': '03-嵌套副本',
    '未关联目标': '未绑定池的 block',
}
POOL_NOTE = '打开各 PLv4 节点的 Editor。Library 点击 Folder 编辑本层和子文件夹的 tag；从 Folder 专用 handle 拖入目标位置，新建绑定该 Folder 的空 block，拖到 block 内部创建子 block。绑定已有 block 请使用设置。Content 编辑实际内容，Pool 用 ＋ 添加候选，已添加项持续标记；子文件夹按钮创建绑定该层并填入本层 tag 的临时子 block。保存 Block 的两个 handle 分别保留结构和仅插 prompts；修改副本后显式从库更新或覆盖回库。单击 Library 共用一个临时标签，编辑或双击后常驻。Schedule / Region / 随机使用节点 seed。'

def pool_labels(value):
    """Update presentation labels, including documents serialized inside widgets."""
    if isinstance(value, dict): return {key: pool_labels(item) for key,item in value.items()}
    if isinstance(value, list): return [pool_labels(item) for item in value]
    if isinstance(value, str):
        if value.lstrip().startswith(('{','[')):
            try: nested=json.loads(value)
            except ValueError: pass
            else:
                if isinstance(nested,(dict,list)):
                    return json.dumps(pool_labels(nested),ensure_ascii=False,separators=(',',':'))
        for old,new in LABELS.items(): value=value.replace(old,new)
    return value

def refresh_pool_samples(library, manifest, workflow):
    # Only the explicitly converted sample library is passed here. Never the original.
    changed={}
    for entry in library.read()['assets'] + library.read()['saved_documents']:
        if entry.get('owner_id'): continue
        asset=library.read('get',id=entry['id'])
        name=pool_labels(asset['name']); data=pool_labels(asset['data'])
        if name==asset['name'] and data==asset['data']: continue
        body={'id':asset['id'],'version':asset['version'],'name':name,'parent_id':asset['parent_id']}
        if asset['kind']=='block': body.update(action='save_block',snapshot=data['snapshot'])
        else: body.update(action='save_'+asset['kind'],data=data)
        library.mutate(body)
        changed[asset['id']]=library.read('get',id=asset['id'])['version']
    # Historical conversion report keeps its original names and kinds for auditing.
    report=manifest.pop('conversion',None)
    manifest=pool_labels(manifest); workflow=pool_labels(workflow)
    if report is not None: manifest['conversion']=report
    def refresh_sources(value):
        if isinstance(value,dict):
            source=value.get('source',{})
            if isinstance(source,dict) and source.get('id') in changed: source['version']=changed[source['id']]
            for item in value.values(): refresh_sources(item)
        elif isinstance(value,list):
            for item in value: refresh_sources(item)
    for sample in manifest['samples']:
        refresh_sources(sample['doc'])
        sample['text']=render(Document.from_json(sample['doc']))
    manifest['assets']=library.read()['assets']
    for node in workflow.get('nodes',[]):
        if node.get('type','').startswith('XYZ Prompt Library V4'):
            widgets=node.get('widgets_values',[])
            for index,value in enumerate(widgets):
                if not isinstance(value,str): continue
                try: doc=json.loads(value)
                except ValueError: continue
                if isinstance(doc,dict) and 'root' in doc:
                    refresh_sources(doc)
                    widgets[index]=json.dumps(doc,ensure_ascii=False,separators=(',',':'))
                    widgets[0]=render(Document.from_json(doc))
            properties=node.get('properties',{})
            if isinstance(properties.get('doc'),str):
                doc=json.loads(properties['doc']); refresh_sources(doc)
                properties['doc']=json.dumps(doc,ensure_ascii=False,separators=(',',':'))
                properties['text']=render(Document.from_json(doc))
        elif node.get('type') in ('MarkdownNote','Note'):
            node['widgets_values']=[POOL_NOTE]
            # MarkdownNote restores properties.text in addition to its widget.
            node.setdefault('properties',{})['text']=POOL_NOTE
            if 'widgets_values_named' in node:
                node['widgets_values_named']['text']=POOL_NOTE
    return manifest,workflow

def convert_samples(root=ROOT):
    root=Path(root).resolve()
    if root!=ROOT.resolve(): raise ValueError('Only the isolated XYZNodes-Test sample root is authorized')
    source=root/'custom_nodes/ComfyUI-XYZNodes/prompt_library_v4_data/plv4.db'
    target=source.with_name('plv4-pools.db')
    manifest_path=root/'sample-content-pools.json'
    workflow_source=root/'XYZNodes-PLv4-验收示例.json'
    workflow_target=root/'XYZNodes-PLv4-Folder池示例.json'
    installed_target=root/'user/default/workflows/XYZNodes-PLv4-Folder池示例.json'
    report_path=root/'plv4-pools-conversion.json'
    outputs=[manifest_path,workflow_target,installed_target,report_path]
    if any(path.exists() for path in [target,*outputs]): raise FileExistsError('Converted samples already exist; originals and converted edits are preserved')
    originals={path:path.read_bytes() for path in [root/'sample-content.json',workflow_source]}
    report=convert(source,target)
    manifest=convert_workflow(json.loads(originals[root/'sample-content.json'].decode('utf-8-sig')),report['mapping'])
    for sample in manifest['samples']:
        sample['title']=sample['title'].replace('Class','Folder 池')
        sample['text']=render(Document.from_json(sample['doc']))
    keys=manifest.get('key_assets',{}); keys['empty_pool']=keys.pop('empty_class',None)
    manifest['conversion']=report
    workflow=convert_workflow(json.loads(originals[workflow_source].decode('utf-8-sig')),report['mapping'])
    for node in workflow.get('nodes',[]):
        if node.get('type','').startswith('XYZ Prompt Library V4'):
            widgets=node.get('widgets_values',[])
            for value in widgets:
                if not isinstance(value,str): continue
                try: doc=json.loads(value)
                except ValueError: continue
                if isinstance(doc,dict) and 'root' in doc:
                    widgets[0]=render(Document.from_json(doc)); break
            node['title']=node.get('title','').replace('Class','Folder 池')
    library=AssetLibrary(target)
    try: manifest,workflow=refresh_pool_samples(library,manifest,workflow)
    finally: library.close()
    for path,value in [(manifest_path,manifest),(workflow_target,workflow),(installed_target,workflow),(report_path,report)]:
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('x',encoding='utf-8') as output: json.dump(value,output,ensure_ascii=False,indent=2)
    if any(path.read_bytes()!=data for path,data in originals.items()): raise RuntimeError('Original samples changed')
    return {**report,'manifest':str(manifest_path),'workflow':str(workflow_target)}

if __name__=='__main__': print(json.dumps(convert_samples(),ensure_ascii=False,indent=2))
