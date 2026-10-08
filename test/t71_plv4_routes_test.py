"""P1 stateless endpoint contract, Unicode edits and real package-loader imports."""
import asyncio
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v4 import routes


class Request:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


def call(handler, body):
    response = asyncio.run(handler(Request(body)))
    return response.status, json.loads(response.body)


def test_open_command_and_preview_require_resolved_node_seed():
    status, opened = call(routes.post_open, {"text": "😀, a, b"})
    assert status == 200
    state = opened["state"]
    a = state["doc"]["root"]["children"][1]["id"]
    status, edited = call(routes.post_command, {"state": state, "command": {
        "type": "SetEnabled", "revision": 0, "id": a, "enabled": False}})
    assert status == 200
    start, end = edited["edit"]["span"]
    encoded = state["text"].encode("utf-16-le")
    applied = (encoded[:start*2] + edited["edit"]["insert"].encode("utf-16-le") + encoded[end*2:]).decode("utf-16-le")
    assert applied == edited["state"]["text"] == "😀, b"
    status, preview = call(routes.post_compile, {"state": edited["state"], "seed": 42, "region_mode": "mask"})
    assert status == 200 and preview["prompt"] == preview["plain"] == "😀, b"
    assert preview["revision"] == 1 and preview["seed"] == 42
    assert call(routes.post_compile, {"state": edited["state"], "region_mode": "mask"})[0] == 400


@pytest.mark.parametrize("command,status,code", [
    ({"type": "Delete", "revision": 7, "id": "i2"}, 409, "stale_revision"),
    ({"type": "Delete", "revision": 0, "id": "missing"}, 422, "unknown_node"),
    ({"type": "oops", "revision": 0}, 422, "unknown_command"),
])
def test_command_rejections_leave_snapshot_unchanged(command, status, code):
    _, opened = call(routes.post_open, {"text": "a, b"})
    before = json.dumps(opened["state"])
    actual, payload = call(routes.post_command, {"state": opened["state"], "command": command})
    assert actual == status and payload["code"] == code
    assert json.dumps(opened["state"]) == before


def test_request_cannot_supply_divergent_text_and_document():
    _, opened = call(routes.post_open, {"text": "a"})
    opened["state"]["text"] = "different"
    status, payload = call(routes.post_compile, {"state": opened["state"], "seed": 2, "region_mode": "couple"})
    assert status == 422 and payload["code"] == "invalid_state"


def test_new_routes_work_in_comfyui_package_namespace_without_root_import():
    package = types.ModuleType("xyz_loader_test")
    package.__path__ = [str(ROOT)]
    sys.modules[package.__name__] = package
    try:
        module = importlib.import_module("xyz_loader_test.prompt_library_v4.routes")
        result = module.dispatch("open", {"text": "{ a }"})
        assert result["state"]["text"] == "{ a }"
    finally:
        for name in list(sys.modules):
            if name == package.__name__ or name.startswith(package.__name__ + "."):
                del sys.modules[name]
