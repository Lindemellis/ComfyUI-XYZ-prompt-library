"""Disposable browser fixture with real PLv4 routes and a synthetic workflow.

python test/manual/plv4_lora_fixture.py
Never uses ComfyUI's processes, model files or personal Library database.
"""
import asyncio
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import zlib
from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.asset_routes import register as register_assets
from prompt_library_v4.routes import register as register_document
from prompt_library_v4.lora_routes import register as register_loras
from prompt_library_v4.loras import LoraBrowser
from prompt_shared.language_routes import _post_ast, _post_compile, _post_doc_sync


PAGE = '''<!doctype html><meta charset="utf-8"><title>PLv4 LoRA isolated check</title>
<style>body{background:#101416;color:#dbe3e6;font:14px sans-serif}pre{white-space:pre-wrap}</style>
<h3>Isolated LoRA fixture</h3><pre id="document"></pre>
<script type="module">
import {PLv4Window} from '/js/plv4/window.js';
import {LoraBrowserWindow} from '/js/plv4/lora_browser.js';
const graph={_nodes:[],setDirtyCanvas(){}};
const app={graph,registerExtension(){}};window.app=app;
await import('/js/tagac.js');
for(const id of [1,2])graph._nodes.push({id,graph,comfyClass:'XYZ Prompt Library V4',title:id===1?'Positive':'Negative',widgets:[{name:'text',value:''},{name:'doc',value:''},{name:'seed',value:42},{name:'region_mode',value:'couple'}]});
window.editor=new PLv4Window(app);
window.browser=new LoraBrowserWindow(app,editor);
editor.openLoras=(node,id)=>browser.open(node,id);
window.fixture={app,graph};
window.errors=[];addEventListener('error',event=>errors.push(event.message));addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
setInterval(()=>document.querySelector('#document').textContent=graph._nodes.map(node=>node.title+': '+node.widgets[0].value).join('\\n'),100);
await browser.open(graph._nodes[0]);window.ready=true;
</script>'''


def png(path, colour):
    def chunk(name, data): return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data))
    width, height = 180, 240
    rows = b''.join(b'\0' + bytes(colour) * width for _ in range(height))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


async def run():
    with tempfile.TemporaryDirectory(prefix='xyz-lora-fixture-') as temp:
        base = Path(temp); models = base / 'models'; models.mkdir()
        for index, name in enumerate(['characters/Amber', 'characters/Blue', 'styles/Ink']):
            path = models / (name + '.safetensors'); path.parent.mkdir(exist_ok=True); path.write_bytes(b'fixture weights')
            triggers = ['Alice with blue eyes and long hair, hat', 'Bob with green eyes and short hair, glasses'] if index == 1 else [name.rsplit('/', 1)[-1].lower() + ', trigger']
            path.with_suffix('.metadata.json').write_text(json.dumps({'civitai': {'id': 10 + index, 'modelId': 100 + index, 'trainedWords': triggers, 'images': []}}))
            png(path.with_suffix('.preview.png'), [(99, 123, 111), (69, 104, 137), (115, 100, 95)][index])
            png(path.with_suffix('.2.png'), (129, 97, 133))
        library = AssetLibrary(base / 'library.db')
        server = SimpleNamespace(routes=web.RouteTableDef())
        register_document(server); register_assets(server, library)
        register_loras(server, LoraBrowser(lambda: [models], library, base / 'cache', fetch_json=lambda digest: {'id': 12, 'modelId': 100, 'trainedWords': ['fetched trigger'], 'images': []}))
        @web.middleware
        async def no_cache(request, handler):
            response = await handler(request); response.headers['Cache-Control'] = 'no-store'; return response
        app = web.Application(middlewares=[no_cache]); app.add_routes(server.routes)
        async def index(request): return web.Response(text=PAGE, content_type='text/html')
        app.router.add_get('/', index); app.router.add_static('/js/', ROOT / 'js')
        async def app_script(request): return web.Response(text='export const app=window.app;', content_type='text/javascript')
        async def widget_script(request): return web.Response(text='export const ComfyWidgets={};', content_type='text/javascript')
        async def tag_search(request): return web.json_response([{'name': 'blue_eyes', 'category': 0, 'post_count': 1000, 'sources': ['danbooru', 'gelbooru'], 'aliases': ['fixture alias']}])
        app.router.add_get('/scripts/app.js', app_script)
        app.router.add_get('/scripts/widgets.js', widget_script)
        app.router.add_get('/xyz/tagdb/search', tag_search)
        app.router.add_static('/xyz/plv3/monaco/', ROOT / 'web' / 'monaco')
        app.router.add_post('/xyz/plv3/ast', _post_ast)
        app.router.add_post('/xyz/plv3/compile', _post_compile)
        app.router.add_post('/xyz/plv3/doc/sync', _post_doc_sync)
        runner = web.AppRunner(app); await runner.setup(); site = web.TCPSite(runner, '127.0.0.1', 0); await site.start()
        print('LORA_TEST_URL=http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1]), flush=True)
        try: await asyncio.Event().wait()
        finally: await runner.cleanup(); library.close()


if __name__ == '__main__':
    try: asyncio.run(run())
    except KeyboardInterrupt: pass
