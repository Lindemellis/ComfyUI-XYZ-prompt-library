"""LLM assistant Phase 1 — schema v7 + repo ops + settings round-trip.

Run: python test/t_llm_phase1_test.py   (or via pytest)
No ComfyUI required.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate, SCHEMA_VERSION
from prompt_library_v2 import repo
import llm.settings as settings


def _fresh_db():
    tmp = tempfile.mkdtemp(prefix="llm_p1_")
    db_path = Path(tmp) / "plv2.db"
    conn = connect_write(db_path)
    try:
        migrate(conn)
    finally:
        conn.close()
    return db_path


def test_schema_v7():
    db_path = _fresh_db()
    conn = connect_write(db_path)
    try:
        (uv,) = conn.execute("PRAGMA user_version").fetchone()
        assert uv == SCHEMA_VERSION >= 7, f"user_version={uv}, SCHEMA_VERSION={SCHEMA_VERSION}"
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        for t in ("llm_blocks", "llm_block_variants", "llm_conversations", "llm_messages"):
            assert t in tables, f"missing table {t}"
    finally:
        conn.close()
    print("ok: schema v7 + tables")


def test_block_ops():
    db_path = _fresh_db()
    repo.init(db_path)
    try:
        # create block (+ default variant, set active)
        bid = repo.enqueue_write(repo.MID, repo.CreateLlmBlockOp(
            kind="task", name="Task", text="hello", order_index=0)).result(timeout=5)
        blocks = repo.get_llm_blocks()
        assert len(blocks) == 1 and blocks[0]["id"] == bid
        assert blocks[0]["text"] == "hello", blocks[0]
        assert blocks[0]["active_variant_id"] is not None

        # add a second variant + make it active
        vid2 = repo.enqueue_write(repo.MID, repo.UpsertLlmVariantOp(
            block_id=bid, text="v2 text", variant_name="alt")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.SetActiveVariantOp(
            block_id=bid, variant_id=vid2)).result(timeout=5)
        blocks = repo.get_llm_blocks()
        assert blocks[0]["text"] == "v2 text", blocks[0]
        variants = repo.get_block_variants(bid)
        assert len(variants) == 2

        # update variant text
        repo.enqueue_write(repo.MID, repo.UpsertLlmVariantOp(
            block_id=bid, text="v2 edited", variant_name="alt", variant_id=vid2)).result(timeout=5)
        assert repo.get_llm_blocks()[0]["text"] == "v2 edited"

        # delete one variant ok; deleting the last must fail
        repo.enqueue_write(repo.MID, repo.DeleteLlmVariantOp(variant_id=vid2)).result(timeout=5)
        assert len(repo.get_block_variants(bid)) == 1
        last_vid = repo.get_block_variants(bid)[0]["id"]
        try:
            repo.enqueue_write(repo.MID, repo.DeleteLlmVariantOp(variant_id=last_vid)).result(timeout=5)
            assert False, "expected last-variant guard to raise"
        except ValueError:
            pass
        # active re-pointed to the surviving variant after deleting the active one
        assert repo.get_llm_blocks()[0]["active_variant_id"] == last_vid

        # partial update + history keep_turns (None means 'all' when keep_turns_set)
        repo.enqueue_write(repo.MID, repo.UpdateLlmBlockOp(
            block_id=bid, enabled=False, keep_turns=5)).result(timeout=5)
        b = repo.get_llm_blocks()[0]
        assert b["enabled"] == 0 and b["keep_turns"] == 5

        # second block + reorder
        bid2 = repo.enqueue_write(repo.MID, repo.CreateLlmBlockOp(
            kind="custom", name="B2", text="", order_index=1)).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.ReorderLlmBlocksOp(
            order_map={bid: 10, bid2: 0})).result(timeout=5)
        ordered = [b["id"] for b in repo.get_llm_blocks()]
        assert ordered == [bid2, bid], ordered

        # delete block
        repo.enqueue_write(repo.MID, repo.DeleteLlmBlockOp(block_id=bid2)).result(timeout=5)
        assert [b["id"] for b in repo.get_llm_blocks()] == [bid]
    finally:
        repo.stop()
    print("ok: block + variant ops")


def test_conversation_ops():
    db_path = _fresh_db()
    repo.init(db_path)
    try:
        cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp(title="t1")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(
            conversation_id=cid, role="user", content="hi")).result(timeout=5)
        repo.enqueue_write(repo.MID, repo.AppendMessageOp(
            conversation_id=cid, role="assistant", content="yo",
            meta={"model": "deepseek-v4-pro", "usage": {"total_tokens": 12}})).result(timeout=5)
        msgs = repo.get_messages(cid)
        assert [m["role"] for m in msgs] == ["user", "assistant"]
        assert msgs[1]["meta"]["usage"]["total_tokens"] == 12, msgs[1]
        repo.enqueue_write(repo.MID, repo.RenameConversationOp(
            conversation_id=cid, title="renamed")).result(timeout=5)
        assert repo.get_conversations()[0]["title"] == "renamed"
        repo.enqueue_write(repo.MID, repo.DeleteConversationOp(conversation_id=cid)).result(timeout=5)
        assert repo.get_conversations() == []
        assert repo.get_messages(cid) == []  # cascade
    finally:
        repo.stop()
    print("ok: conversation + message ops")


def test_settings_roundtrip():
    tmp = tempfile.mkdtemp(prefix="llm_set_")
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"

    pub = settings.public()
    assert pub["provider"] == "deepseek"
    assert pub["providers"]["deepseek"]["has_key"] is False
    assert settings.active_provider_config()["model"] == "deepseek-v4-pro"

    settings.update({"provider_update": {"id": "deepseek", "api_key": "sk-abcdef1234567890"},
                     "temperature": 0.7, "lookup_sources": {"gelbooru": True}})
    pub = settings.public()
    assert pub["providers"]["deepseek"]["has_key"] is True
    assert pub["providers"]["deepseek"]["api_key_masked"].startswith("sk-")
    assert pub["providers"]["deepseek"]["api_key_masked"].endswith("7890")
    assert abs(pub["temperature"] - 0.7) < 1e-9
    assert pub["lookup_sources"]["gelbooru"] is True

    # mask sentinel keeps the existing key
    settings.update({"provider_update": {"id": "deepseek", "api_key": settings.MASK_SENTINEL, "model": "deepseek-chat"}})
    assert settings.active_provider_config()["api_key"] == "sk-abcdef1234567890"
    assert settings.active_provider_config()["model"] == "deepseek-chat"
    print("ok: settings round-trip + masking")


def main():
    test_schema_v7()
    test_block_ops()
    test_conversation_ops()
    test_settings_roundtrip()
    print("\nALL PHASE-1 CHECKS PASSED")


if __name__ == "__main__":
    main()
