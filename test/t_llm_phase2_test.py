"""LLM Phase 2/6 — assembly, tool loop, cap, digest (stubbed client, no network)."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
import llm.store as store
import llm.settings as settings
import llm.assembly as assembly
import llm.chat as chat


def _fresh_repo():
    tmp = tempfile.mkdtemp(prefix="llm_p2_")
    db_path = Path(tmp) / "plv2.db"
    c = connect_write(db_path); migrate(c); c.close()
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"
    repo.init(db_path)
    return db_path


def test_assembly():
    _fresh_repo()
    try:
        store.seed_defaults_if_needed()  # seeds the 8 default blocks
        msgs = assembly.build_messages(None, base_prompt="1girl, solo", user_request="make it a knight")
        assert msgs[0]["role"] == "system"
        assert "danbooru" in msgs[0]["content"].lower()
        assert msgs[-1]["role"] == "user"
        assert "knight" in msgs[-1]["content"] and "1girl" in msgs[-1]["content"]
        print("ok: assembly system+user mapping")
    finally:
        repo.stop()


def test_tool_loop_and_cap():
    _fresh_repo()
    try:
        store.seed_defaults_if_needed()

        # Stub the lookup tool to return a fixed real-looking result.
        chat._tools.execute_lookup = lambda args, src: [
            {"name": "twintails", "post_count": 500000, "category_name": "general", "aliases": []},
        ]

        # Stub client: 1st call → a tool_call; 2nd call → final answer.
        calls = {"n": 0}
        def fake_complete(settings_, messages, tools=None):
            calls["n"] += 1
            if calls["n"] == 1:
                assert tools, "tools should be passed on the first call"
                return {"message": {"role": "assistant", "content": "",
                                    "tool_calls": [{"id": "c1", "function":
                                        {"name": "lookup_danbooru_tags",
                                         "arguments": json.dumps({"queries": ["twintails"]})}}]},
                        "usage": {"total_tokens": 10}, "model": "deepseek-v4-pro"}
            return {"message": {"role": "assistant", "content": "```prompt\n1girl, twintails\n```"},
                    "usage": {"total_tokens": 20}, "model": "deepseek-v4-pro"}
        chat._client.complete = fake_complete

        res = chat.run_chat({"model": "deepseek-v4-pro"}, [{"role": "user", "content": "hi"}],
                            enable_tools=True, sources=[("danbooru", Path("x"))])
        assert res["capped"] is False
        assert "twintails" in res["message"]["content"]
        assert len(res["trace"]) == 1 and res["trace"][0]["results"][0]["name"] == "twintails"
        print("ok: tool loop one round + final")

        # Cap: always return tool_calls; after MAX_ITERS force-final (tools=None) returns text.
        def always_tool(settings_, messages, tools=None):
            if tools is None:
                return {"message": {"role": "assistant", "content": "forced final"},
                        "usage": None, "model": "m"}
            return {"message": {"role": "assistant", "content": "",
                                "tool_calls": [{"id": "c", "function":
                                    {"name": "lookup_danbooru_tags",
                                     "arguments": json.dumps({"queries": ["x"]})}}]},
                    "usage": None, "model": "m"}
        chat._client.complete = always_tool
        res2 = chat.run_chat({"model": "m"}, [{"role": "user", "content": "hi"}],
                             enable_tools=True, sources=[("danbooru", Path("x"))])
        assert res2["capped"] is True and res2["message"]["content"] == "forced final"
        assert len(res2["trace"]) == chat.MAX_ITERS
        print("ok: tool loop cap → forced final")
    finally:
        repo.stop()


def test_digest():
    _fresh_repo()
    try:
        cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp(title="t")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(
            conversation_id=cid, role="tool",
            content=json.dumps([{"name": "twintails", "post_count": 500000},
                                {"name": "yandere", "post_count": 90000}]))).result(timeout=5)
        d = assembly.verified_tag_digest(cid)
        assert "twintails" in d and "yandere" in d and "500000" in d
        print("ok: verified-tag digest")
    finally:
        repo.stop()


def main():
    test_assembly()
    test_tool_loop_and_cap()
    test_digest()
    print("\nALL PHASE-2 CHECKS PASSED")


if __name__ == "__main__":
    main()
