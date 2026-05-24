"""PLv2 routes integration test (mock aiohttp server)."""
import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
from prompt_library_v2.trigger import rebuild_auto_triggers
from prompt_library_v2 import routes as _routes
from prompt_library_v2.routes import (
    _get_nodes, _post_nodes, _patch_node, _delete_node, _move_node,
    _get_prompts, _post_prompt, _patch_prompt, _delete_prompt, _reorder_prompts,
    _get_triggers, _post_trigger, _delete_trigger,
    _preview_node, _resolve_template,
    _get_common_formats, _get_common_delimiters,
)

# ---------------------------------------------------------------------------
# Mock aiohttp infrastructure
# ---------------------------------------------------------------------------

class MockRoutes:
    def _reg(self, method, path):
        def decorator(fn): return fn
        return decorator
    def get(self, p): return self._reg("GET", p)
    def post(self, p): return self._reg("POST", p)
    def patch(self, p): return self._reg("PATCH", p)
    def delete(self, p): return self._reg("DELETE", p)


class MockServer:
    def __init__(self):
        self.routes = MockRoutes()


class MockRequest:
    def __init__(self, body=None, path_id=None):
        self._body = body or {}
        self.match_info = {"id": str(path_id)} if path_id is not None else {}

    async def json(self):
        return self._body


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

errors = []


def check(label, got, expected):
    if got != expected:
        errors.append(f"FAIL [{label}]: got {got!r}, expected {expected!r}")
    else:
        print(f"  OK  [{label}]")


def jbody(resp):
    return json.loads(resp.body)


# ---------------------------------------------------------------------------
# Main test
# ---------------------------------------------------------------------------

async def run_tests(db_path):
    # Register routes (idempotency check)
    srv = MockServer()
    _routes.register(srv)
    _routes.register(srv)  # second call must be no-op
    assert _routes._registered

    # ── Nodes ────────────────────────────────────────────────────────────
    print("\n=== Nodes ===")
    resp = await _post_nodes(MockRequest({"name": "character", "has_template": True, "has_prompts": False}))
    check("create root status", resp.status, 201)
    char_id = jbody(resp)["node"]["id"]
    check("root full_path", jbody(resp)["node"]["full_path"], "character")

    resp = await _post_nodes(MockRequest({"name": "toki", "parent_id": char_id, "has_prompts": True}))
    check("create child status", resp.status, 201)
    toki_id = jbody(resp)["node"]["id"]
    check("child full_path", jbody(resp)["node"]["full_path"], "character.toki")

    # Duplicate path → 409
    resp = await _post_nodes(MockRequest({"name": "toki", "parent_id": char_id}))
    check("duplicate path", resp.status, 409)

    # Dot in name → 400
    resp = await _post_nodes(MockRequest({"name": "bad.name", "parent_id": char_id}))
    check("dot in name", resp.status, 400)

    # GET tree
    resp = await _get_nodes(MockRequest())
    check("tree count", len(jbody(resp)["nodes"]), 2)

    # PATCH scalar fields
    resp = await _patch_node(MockRequest({"random_mode": "select", "select_min": 1, "select_max": 3}, path_id=toki_id))
    check("patch random_mode", jbody(resp)["node"]["random_mode"], "select")

    # PATCH rename
    resp = await _patch_node(MockRequest({"name": "renamed_toki"}, path_id=toki_id))
    check("rename path", jbody(resp)["node"]["full_path"], "character.renamed_toki")

    # Rename back
    await _patch_node(MockRequest({"name": "toki"}, path_id=toki_id))

    # ── Prompts ──────────────────────────────────────────────────────────
    print("\n=== Prompts ===")
    resp = await _post_prompt(MockRequest({"content": "kamisato toki", "weight": 1.0, "order_index": 0}, path_id=toki_id))
    check("add prompt", resp.status, 201)
    p1_id = jbody(resp)["prompt"]["id"]

    resp = await _post_prompt(MockRequest({"content": "toki (blue archive)", "order_index": 1}, path_id=toki_id))
    p2_id = jbody(resp)["prompt"]["id"]

    resp = await _get_prompts(MockRequest(path_id=toki_id))
    check("list prompts", len(jbody(resp)["prompts"]), 2)

    # Reorder
    resp = await _reorder_prompts(MockRequest({"order": [[p1_id, 10], [p2_id, 5]]}, path_id=toki_id))
    check("reorder first", jbody(resp)["prompts"][0]["id"], p2_id)

    # Delete prompt
    resp = await _delete_prompt(MockRequest(path_id=p2_id))
    check("delete prompt", resp.status, 200)
    check("prompt gone", repo.get_prompt(p2_id), None)

    # ── Preview / Resolve ─────────────────────────────────────────────────
    # Run here: only p1="kamisato toki" (weight=1.0) remains; random_mode='select'
    # with 1 candidate always returns that single prompt regardless of seed.
    print("\n=== Preview / Resolve ===")
    resp = await _preview_node(MockRequest({"seed": 42}, path_id=toki_id))
    check("preview text", jbody(resp)["text"], "kamisato toki")

    resp = await _resolve_template(MockRequest({"template": "[toki], solo", "seed": 0}))
    check("resolve template", jbody(resp)["text"], "kamisato toki, solo")

    # PATCH prompt weight
    resp = await _patch_prompt(MockRequest({"weight": 1.2}, path_id=p1_id))
    check("patch prompt ok", resp.status, 200)
    check("weight updated", repo.get_prompt(p1_id)["weight"], 1.2)

    # Template-locked prompt cannot be deleted
    resp = await _post_prompt(MockRequest({"content": "locked", "source": "template"}, path_id=toki_id))
    locked_id = jbody(resp)["prompt"]["id"]
    resp = await _delete_prompt(MockRequest(path_id=locked_id))
    check("locked prompt 403", resp.status, 403)

    # ── Triggers ─────────────────────────────────────────────────────────
    print("\n=== Triggers ===")
    rebuild_auto_triggers().result(2)

    resp = await _get_triggers(MockRequest(path_id=toki_id))
    auto = [t for t in jbody(resp)["triggers"] if t["is_auto"]]
    check("auto trigger exists", len(auto), 1)
    check("auto trigger text", auto[0]["trigger_text"], "toki")

    resp = await _post_trigger(MockRequest({"trigger_text": "tk"}, path_id=toki_id))
    check("add custom trigger", resp.status, 201)

    resp = await _post_trigger(MockRequest({"trigger_text": "tk"}, path_id=toki_id))
    check("duplicate trigger 409", resp.status, 409)

    triggers = repo.get_triggers(toki_id)
    custom_t = next(t for t in triggers if not t["is_auto"])
    resp = await _delete_trigger(MockRequest(path_id=custom_t["id"]))
    check("delete custom trigger", resp.status, 200)

    triggers = repo.get_triggers(toki_id)
    auto_t = next(t for t in triggers if t["is_auto"])
    resp = await _delete_trigger(MockRequest(path_id=auto_t["id"]))
    check("cannot delete auto 403", resp.status, 403)

    # ── Validation: names, trigger uniqueness, shadow pruning (#1/#2/#4) ───
    print("\n=== Validation ===")
    # #2 — delimiter chars rejected in names
    for bad in ["a,b", "a|b", "a/b", "a\\b"]:
        resp = await _post_nodes(MockRequest({"name": bad, "parent_id": char_id}))
        check(f"reject name {bad!r}", resp.status, 400)

    # #1 — trigger may not equal a node path or an entry's default name
    resp = await _post_trigger(MockRequest({"trigger_text": "character"}, path_id=toki_id))
    check("trigger == path 409", resp.status, 409)
    resp = await _post_trigger(MockRequest({"trigger_text": "toki"}, path_id=toki_id))
    check("trigger == default name 409", resp.status, 409)

    # #4 — a rename whose new path shadows a custom trigger removes + reports it
    resp = await _post_trigger(MockRequest({"trigger_text": "zzz"}, path_id=toki_id))
    check("add zzz trigger", resp.status, 201)
    resp = await _post_nodes(MockRequest({"name": "qqq", "has_prompts": True}))
    qqq_id = jbody(resp)["node"]["id"]
    resp = await _patch_node(MockRequest({"name": "zzz"}, path_id=qqq_id))   # full_path -> "zzz"
    removed = jbody(resp).get("removed_triggers", [])
    check("shadowed trigger reported", any(r["trigger_text"] == "zzz" for r in removed), True)
    check("shadowed trigger removed", any(t["trigger_text"] == "zzz" for t in repo.get_triggers(toki_id)), False)
    await _delete_node(MockRequest(path_id=qqq_id))

    # ── Common ───────────────────────────────────────────────────────────
    print("\n=== Common ===")
    resp = await _get_common_delimiters(MockRequest())
    check("common delimiters", len(jbody(resp)["delimiters"]), 2)

    resp = await _get_common_formats(MockRequest())
    check("common formats list", isinstance(jbody(resp)["formats"], list), True)

    # ── Move node ─────────────────────────────────────────────────────────
    print("\n=== Move ===")
    resp = await _post_nodes(MockRequest({"name": "other", "has_prompts": False}))
    other_id = jbody(resp)["node"]["id"]

    resp = await _move_node(MockRequest({"parent_id": other_id, "name": "toki"}, path_id=toki_id))
    check("move node path", jbody(resp)["node"]["full_path"], "other.toki")

    # ── Delete subtree ────────────────────────────────────────────────────
    resp = await _delete_node(MockRequest(path_id=other_id))
    check("delete node", resp.status, 200)
    check("parent gone", repo.get_node(other_id), None)
    check("child gone via cascade", repo.get_node(toki_id), None)


def main():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = f.name

    try:
        conn = connect_write(db_path)
        migrate(conn)
        conn.close()
        repo.init(db_path)

        asyncio.run(run_tests(db_path))

        repo.stop()
    finally:
        os.unlink(db_path)

    print()
    if errors:
        for e in errors:
            print(e)
        sys.exit(1)
    else:
        print("All route tests passed.")


if __name__ == "__main__":
    main()
