"""Retirement preparation: V4 startup survives unavailable V3 Library services."""
import atexit
import asyncio
import importlib
from pathlib import Path
import sys
import subprocess
from types import ModuleType, SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def server():
    return SimpleNamespace(app=web.Application(), routes=web.RouteTableDef())


def fake_folder_paths(monkeypatch):
    module = ModuleType('folder_paths')
    module.get_folder_paths = lambda name: []
    module.folder_names_and_paths = {'loras': ([], {'.safetensors'})}
    monkeypatch.setitem(sys.modules, module.__name__, module)


async def check_v4_http(instance):
    instance.app.add_routes(instance.routes)
    async with TestClient(TestServer(instance.app)) as client:
        response = await client.get('/xyz/plv3/monaco/vs/loader.js')
        assert response.status == 200 and 'require' in await response.text()
        response = await client.post('/xyz/plv4/document/open', json={'text': 'a, b'})
        opened = await response.json()
        assert response.status == 200 and opened['state']['text'] == 'a, b'
        response = await client.post('/xyz/plv4/document/compile', json={
            'state': opened['state'], 'seed': 3, 'region_mode': 'couple'})
        compiled = await response.json()
        assert response.status == 200 and compiled['prompt'] == compiled['plain'] == 'a, b'
        response = await client.post('/xyz/plv4/library/read', json={'action': 'tree'})
        assert response.status == 200 and (await response.json())['ok']
        response = await client.post('/xyz/plv4/loras/complete', json={'query': ''})
        assert response.status == 200 and (await response.json())['ok']
        assert (await client.get('/xyz/plv3/library/tree')).status == 404
        # Untouched V3 Monaco nodes still lint/sync without a Library or conversion.
        response = await client.post('/xyz/plv3/doc/sync', json={'text': '{ red, blue }'})
        doc = (await response.json())['doc']
        assert response.status == 200 and doc['root'].get('meta', {}).get('compiler') != 'plv4'
        item = doc['root']['children'][0]['children'][0]
        response = await client.post('/xyz/plv3/doc/toggle', json={
            'doc': doc, 'id': item['id'], 'enabled': False})
        toggled = await response.json()
        assert response.status == 200 and 'red' not in toggled['text']
        assert toggled['doc']['root']['children'][0]['children'][0]['enabled'] is False
        response = await client.post('/xyz/plv3/compile', json={'text': toggled['text']})
        assert response.status == 200 and 'blue' in (await response.json())['text']
        response = await client.post('/xyz/plv3/ast', json={'text': toggled['text']})
        assert response.status == 200 and (await response.json())['ok']


def test_v4_setup_alone_serves_document_library_loras_and_monaco(tmp_path, monkeypatch):
    from prompt_library_v4 import setup
    fake_folder_paths(monkeypatch)
    monkeypatch.setattr(setup, '_library', None)
    instance = server()
    path = tmp_path / 'v4' / 'plv4-pools.db'
    library = setup.setup(instance, path)
    try:
        # Repeated setup must not duplicate routes/static resources.
        assert setup.setup(instance, path) is library
        asyncio.run(check_v4_http(instance))
        assert not (path.parent / 'library.db').exists()
    finally:
        atexit.unregister(library.close)
        library.close()


@pytest.mark.parametrize('v3_first', [False, True])
def test_shared_monaco_registration_survives_both_setup_orders(v3_first, monkeypatch):
    from prompt_library_v3 import routes as v3
    from prompt_library_v4 import routes as v4
    from prompt_shared.routes import register_monaco
    monkeypatch.setattr(v3, '_registered', False)
    instance = server()
    if v3_first:
        v3.register(instance)
    v4.register(instance)
    register_monaco(instance)
    if not v3_first:
        v3.register(instance)
    v4.register(instance)
    register_monaco(instance)
    instance.app.add_routes(instance.routes)
    paths = [resource.canonical for resource in instance.app.router.resources()]
    assert paths.count('/xyz/plv3/monaco') == 1
    assert paths.count('/xyz/plv4/document/open') == 1
    assert paths.count('/xyz/plv3/library/tree') == 1


def test_pack_startup_never_initializes_retired_v3_library(tmp_path, monkeypatch):
    # Run the real pack initializer in ComfyUI's package namespace, isolating
    # unrelated Gallery/TagDB/Krita services and all personal runtime data.
    name = 'xyz_retirement_startup_test'
    package = ModuleType(name)
    package.__path__ = [str(ROOT)]
    monkeypatch.setitem(sys.modules, name, package)
    fake_folder_paths(monkeypatch)
    instance = server()
    monkeypatch.setitem(sys.modules, 'server', SimpleNamespace(
        PromptServer=SimpleNamespace(instance=instance)))
    library = None
    try:
        v3 = importlib.import_module(name + '.prompt_library_v3')
        calls = []
        def unavailable():
            calls.append('legacy setup')
            raise AssertionError('Retired V3 Library must never start')
        monkeypatch.setattr(v3, 'setup', unavailable)
        legacy_repo = importlib.import_module(name + '.prompt_library_v3.repo')
        monkeypatch.setattr(legacy_repo, 'init', lambda *args: calls.append('legacy writer'))
        v4 = importlib.import_module(name + '.prompt_library_v4.setup')
        real_setup = v4.setup
        def setup_temp(server):
            return real_setup(server, tmp_path / 'plv4-pools.db')
        monkeypatch.setattr(v4, 'setup', setup_temp)
        exports = {
            'mask_nodes': ['XYZAttachMasks', 'XYZMaskEditor'],
            'krita_nodes': ['XYZKritaFetchColorMasks', 'XYZKritaFetchImage', 'XYZKritaFetchMask',
                            'XYZKritaOpenFile', 'XYZKritaSendToKrita'],
            'cache_nodes': ['XYZCacheSlotRead', 'XYZCacheSlotWrite'],
            'inpaint_nodes': ['XYZInpaintStitchToRGBA'],
            'gallery': [], 'tagdb': [], 'agent_nodes': [], 'quantized_hook_compat': [],
        }
        for relative, classes in exports.items():
            stub = ModuleType(name + '.' + relative)
            for cls in classes:
                setattr(stub, cls, type(cls, (), {}))
            stub.setup = lambda *args: None
            stub.install = lambda: None
            monkeypatch.setitem(sys.modules, stub.__name__, stub)
        exec(compile((ROOT / '__init__.py').read_text(encoding='utf-8'),
                     str(ROOT / '__init__.py'), 'exec'), package.__dict__)
        library = v4._library
        assert library is not None
        assert set(package.NODE_CLASS_MAPPINGS) >= {
            'XYZ Prompt Library V3', 'XYZ Prompt Library V3 Monaco',
            'XYZ Prompt Library V4', 'XYZ Prompt Library V4 Monaco'}
        asyncio.run(check_v4_http(instance))
        assert calls == []
        assert all(getattr(package.NODE_CLASS_MAPPINGS[name], 'DEPRECATED', False) for name in (
            'XYZ Prompt Library V3', 'XYZ Prompt Library V3 Monaco'))
        assert not getattr(package.NODE_CLASS_MAPPINGS['XYZ Prompt Library V4'], 'DEPRECATED', False)
    finally:
        if library is not None:
            atexit.unregister(library.close)
            library.close()
        for module in list(sys.modules):
            if module.startswith(name + '.'):
                sys.modules.pop(module, None)


def test_shared_language_import_does_not_load_legacy_storage():
    result = subprocess.run([sys.executable, '-c',
        "import sys; import prompt_shared.language_routes; import prompt_library_v4.setup; "
        "assert not any(name == 'prompt_library_v3' or name.startswith('prompt_library_v3.') "
        "for name in sys.modules)"],
        cwd=ROOT, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize('name', ['lexer', 'parser', 'diagnostics', 'document',
    'ast_json', 'validate', 'ir', 'compile', 'compile.common', 'compile.couple', 'compile.mask'])
def test_historical_language_imports_share_module_identity(name):
    assert importlib.import_module('prompt_library_v3.' + name) is importlib.import_module(
        'prompt_shared.language.' + name)


def test_legacy_storage_exports_use_the_shared_implementation():
    from prompt_shared import storage
    from prompt_library_v3 import db, repo
    from prompt_library_v4 import assets
    assert repo.WriteQueue is assets.WriteQueue is storage.WriteQueue
    assert db.connect_read is assets.connect_read is storage.connect_read
    assert db.connect_write is storage.connect_write
