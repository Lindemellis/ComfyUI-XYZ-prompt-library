"""Library HTTP transactions and package-loader import contract."""
import asyncio
import importlib
import json
from pathlib import Path
import sys
import types

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.asset_routes import register
from prompt_library_v4.model import EditorState


class Routes:
    def post(self, path):
        def decorate(handler): self.handler = handler; self.path = path; return handler
        return decorate


class Request:
    def __init__(self, body, operation): self.body = body; self.match_info = {'operation': operation}
    async def json(self): return self.body


@pytest.fixture
def endpoint(tmp_path):
    library = AssetLibrary(tmp_path / 'v4.db'); server = types.SimpleNamespace(routes=Routes())
    register(server, library)
    def call(body, operation='mutate'):
        response = asyncio.run(server.routes.handler(Request(body, operation)))
        return response.status, json.loads(response.body)
    yield call, library
    library.close()


def test_http_shared_conflicts_and_malformed_request(endpoint):
    call, library = endpoint
    status, saved = call({'action': 'save_class', 'name': 'C'})
    assert status == 200 and saved['ok']
    status, result = call({'action': 'save_class', 'id': saved['id'], 'version': 0, 'name': 'Outdated'})
    assert status == 409 and result['code'] == 'asset_conflict'
    assert call([], 'read')[0] == 400
    assert call({}, 'migrate')[0] == 422
    assert library.read('get', id=saved['id'])['name'] == 'C'


def test_http_edit_and_attribute_add_are_one_response(endpoint):
    call, library = endpoint
    _, saved = call({'action': 'save_class', 'name': 'C'})
    state = EditorState.create(text='{ a }')
    status, result = call({'action': 'edit', 'owner': 'workflow', 'state': state.to_json(), 'command': {
        'type': 'SetMetadata', 'id': state.doc.root.children[0].id, 'revision': 0, 'patch': {'pool': saved['id']}}})
    assert status == 200 and result['state']['revision'] == 1
    assert result['projection']['revision'] == 1
    assert any(a['kind'] == 'tag' and a['name'] == 'a' for a in library.read()['assets'])


def test_asset_service_and_v4_nodes_import_in_real_loader_namespace():
    package = types.ModuleType('xyz_v4_loader_test'); package.__path__ = [str(Path(__file__).resolve().parents[1])]; sys.modules[package.__name__] = package
    try:
        asset_module = importlib.import_module('xyz_v4_loader_test.prompt_library_v4.assets')
        node_module = importlib.import_module('xyz_v4_loader_test.prompt_library_v4.node')
        migration_module = importlib.import_module('xyz_v4_loader_test.prompt_library_v4.migrate_v3')
        assert hasattr(asset_module, 'AssetLibrary') and hasattr(migration_module, 'migrate')
        assert node_module.PromptLibraryV4Node().execute('a', seed=2) == ('a', 'a')
    finally:
        for name in list(sys.modules):
            if name == package.__name__ or name.startswith(package.__name__ + '.'): del sys.modules[name]
