"""LLM route-level test — _post_chat end-to-end with a stubbed client (no network)."""
import asyncio
import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
import llm.settings as settings
import llm.store as store
import llm.chat as chat
import llm.tools as tools
import llm.routes as routes


class _Query:
    def __init__(self, qs): self._q = qs
    def get(self, k, default=None): return self._q.get(k, [default])[0] if k in self._q else default


class _RelUrl:
    def __init__(self, query=""): self.query = _Query(parse_qs(query))


class MockRequest:
    def __init__(self, body=None, path_id=None, query=""):
        self._body = body or {}
        self.match_info = {"id": str(path_id)} if path_id is not None else {}
        self.rel_url = _RelUrl(query)
    async def json(self): return self._body


def _resp_json(resp):
    import json
    return json.loads(resp.body.decode("utf-8")), resp.status


def _setup():
    tmp = tempfile.mkdtemp(prefix="llm_routes_")
    db_path = Path(tmp) / "plv2.db"
    c = connect_write(db_path); migrate(c); c.close()
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"
    repo.init(db_path)
    store.seed_defaults_if_needed()
    # no real tagdb in tests
    tools.resolve_sources = lambda cfg: []


def test_chat_no_key():
    _setup()
    try:
        resp = asyncio.run(routes._post_chat(MockRequest({"user_request": "hi"})))
        data, status = _resp_json(resp)
        assert status == 400 and data["error"]["code"] == "no_api_key", data
        print("ok: chat refuses without api key")
    finally:
        repo.stop()


def test_chat_success_persists():
    _setup()
    try:
        settings.update({"provider_update": {"id": "deepseek", "api_key": "sk-test123456"}})
        chat._client.complete = lambda s, m, tools=None: {
            "message": {"role": "assistant", "content": "```prompt\n1girl, solo\n```"},
            "usage": {"total_tokens": 30}, "model": "deepseek-v4-pro"}

        cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp(title="t")).result(timeout=5)
        resp = asyncio.run(routes._post_chat(MockRequest({
            "conversation_id": cid, "base_prompt": "1girl", "user_request": "make her a knight"})))
        data, status = _resp_json(resp)
        assert status == 200, data
        assert "1girl" in data["message"]["content"]
        # persisted: user + assistant
        msgs = repo.get_messages(cid)
        roles = [m["role"] for m in msgs]
        assert roles == ["user", "assistant"], roles
        assert msgs[0]["content"] == "make her a knight"
        assert msgs[0]["meta"]["base_prompt"] == "1girl"
        assert msgs[1]["meta"]["usage"]["total_tokens"] == 30
        print("ok: chat success persists user+assistant")
    finally:
        repo.stop()


def test_chat_api_error_keeps_user():
    _setup()
    try:
        settings.update({"provider_update": {"id": "deepseek", "api_key": "sk-test"}})
        def boom(s, m, tools=None): raise chat._client.LlmError("API 500: upstream blew up")
        chat._client.complete = boom
        cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp(title="t")).result(timeout=5)
        resp = asyncio.run(routes._post_chat(MockRequest({
            "conversation_id": cid, "user_request": "hello"})))
        data, status = _resp_json(resp)
        assert status == 502 and data["error"]["code"] == "api_error", data
        msgs = repo.get_messages(cid)
        assert [m["role"] for m in msgs] == ["user"], "user message must be kept, no assistant"
        print("ok: api error keeps user msg, no assistant")
    finally:
        repo.stop()


def test_regenerate_delete_includes_user():
    _setup()
    try:
        cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp()).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(conversation_id=cid, role="user", content="q1")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(conversation_id=cid, role="user", content="q2")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(conversation_id=cid, role="tool", content="[]")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(conversation_id=cid, role="assistant", content="a2")).result(timeout=5)
        resp = asyncio.run(routes._delete_last_assistant(MockRequest(path_id=cid, query="include_user=1")))
        data, _ = _resp_json(resp)
        assert len(data["deleted"]) == 3, data  # q2 + tool + a2
        roles = [m["role"] for m in repo.get_messages(cid)]
        assert roles == ["user"], roles  # only q1 remains
        print("ok: regenerate delete drops user+tool+assistant of last turn")
    finally:
        repo.stop()


def main():
    test_chat_no_key()
    test_chat_success_persists()
    test_chat_api_error_keeps_user()
    test_regenerate_delete_includes_user()
    print("\nALL LLM ROUTE CHECKS PASSED")


if __name__ == "__main__":
    main()
