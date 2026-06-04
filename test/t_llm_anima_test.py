"""LLM anima preset + web_search tool — seeding idempotency and tool-loop dispatch."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
import llm.store as store
import llm.settings as settings
import llm.chat as chat
import llm.tools as tools
import llm.dsml as dsml
from llm.defaults import ANIMA_VARIANT_NAME, ANIMA_BLOCKS


def _fresh_repo():
    tmp = tempfile.mkdtemp(prefix="llm_anima_")
    db_path = Path(tmp) / "plv2.db"
    c = connect_write(db_path); migrate(c); c.close()
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"
    repo.init(db_path)
    return db_path


def test_anima_seed_adds_variants_idempotently():
    _fresh_repo()
    try:
        store.seed_defaults_if_needed()
        store.seed_anima_variants_if_needed()

        blocks = repo.get_llm_blocks()
        # web_search block exists and stays grouped before base_prompt
        kinds = [b["kind"] for b in blocks]
        assert "web_search" in kinds
        assert kinds.index("web_search") < kinds.index("base_prompt")

        # every ANIMA_BLOCKS kind gained an "anima" variant; active variant unchanged
        for b in blocks:
            if b["kind"] in ANIMA_BLOCKS:
                names = [v["variant_name"] for v in repo.get_block_variants(b["id"])]
                assert ANIMA_VARIANT_NAME in names, b["kind"]
                assert b["variant_name"] == "default"  # opt-in, not auto-activated

        assert settings.is_anima_seeded()

        # second run is a no-op (no duplicate anima variants)
        store.seed_anima_variants_if_needed()
        hdr = next(b for b in repo.get_llm_blocks() if b["kind"] == "header")
        names = [v["variant_name"] for v in repo.get_block_variants(hdr["id"])]
        assert names.count(ANIMA_VARIANT_NAME) == 1
        print("ok: anima seed adds variants + web_search block, idempotent")
    finally:
        repo.stop()


def test_web_search_dispatch_in_tool_loop():
    # The model asks for web_search once, then answers. The loop must dispatch it to
    # tools.execute_web_search and fold the result into the trace.
    calls = {"n": 0}

    def fake_complete(settings_, messages, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            assert tools and any(t["function"]["name"] == "web_search" for t in tools)
            return {"message": {"role": "assistant", "content": "",
                                "tool_calls": [{"id": "c1", "type": "function",
                                                "function": {"name": "web_search",
                                                             "arguments": '{"queries":["danbooru chibi"]}'}}]},
                    "usage": {}, "model": "m"}
        return {"message": {"role": "assistant", "content": "done"}, "usage": {}, "model": "m"}

    orig_complete = chat._client.complete
    orig_search = tools.execute_web_search
    chat._client.complete = fake_complete
    tools.execute_web_search = lambda args: [{"title": "Chibi", "url": "https://danbooru.donmai.us", "snippet": "x", "query": args["queries"][0]}]
    try:
        res = chat.run_chat({"model": "m"}, [{"role": "user", "content": "hi"}],
                            enable_tools=False, enable_web_search=True)
        assert res["message"]["content"] == "done"
        assert len(res["trace"]) == 1
        assert res["trace"][0]["name"] == "web_search"
        assert res["trace"][0]["results"][0]["url"] == "https://danbooru.donmai.us"
        print("ok: web_search dispatched in tool loop")
    finally:
        chat._client.complete = orig_complete
        tools.execute_web_search = orig_search


def test_ddg_html_parsing():
    sample = (
        '<a rel="nofollow" class="result__a" '
        'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdanbooru.donmai.us%2Fwiki%2Fchibi&rut=z">'
        'Chibi &amp; friends</a>'
        '<a class="result__snippet" href="x">A <b>chibi</b> character.</a>'
    )
    m = list(tools._RESULT_RE.finditer(sample))
    s = list(tools._SNIPPET_RE.finditer(sample))
    assert tools._clean_ddg_href(m[0].group("href")) == "https://danbooru.donmai.us/wiki/chibi"
    assert tools._strip_html(m[0].group("title")) == "Chibi & friends"
    assert tools._strip_html(s[0].group("snippet")) == "A chibi character."
    print("ok: DuckDuckGo HTML parse + uddg unwrap")


_DSML = (
    "Let me look those up.\n"
    "<｜｜DSML｜｜tool_calls>\n"
    "<｜｜DSML｜｜invoke name=\"lookup_danbooru_tags\">\n"
    "<｜｜DSML｜｜parameter name=\"limit\" string=\"false\">10</｜｜DSML｜｜parameter>\n"
    "<｜｜DSML｜｜parameter name=\"queries\" string=\"false\">[\"twintails\",\"saliva\"]</｜｜DSML｜｜parameter>\n"
    "</｜｜DSML｜｜invoke>\n"
    "</｜｜DSML｜｜tool_calls>"
)


def test_dsml_parse_and_strip():
    import json
    assert dsml.has_dsml(_DSML)
    calls = dsml.parse_tool_calls(_DSML)
    assert len(calls) == 1 and calls[0]["function"]["name"] == "lookup_danbooru_tags"
    args = json.loads(calls[0]["function"]["arguments"])
    assert args["limit"] == 10 and args["queries"] == ["twintails", "saliva"]  # typed, not str
    assert dsml.strip(_DSML) == "Let me look those up."
    print("ok: DSML parse + strip (typed args)")


def test_dsml_recovered_in_tool_loop():
    """A model that leaks a DSML call in content (no structured tool_calls) must still get
    the call executed, then produce a clean final answer with no DSML markup."""
    calls = {"n": 0}

    def fake_complete(settings_, messages, tools=None):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"message": {"role": "assistant", "content": _DSML}, "usage": {}, "model": "m"}
        return {"message": {"role": "assistant", "content": "1girl, twintails, saliva"},
                "usage": {}, "model": "m"}

    orig = chat._client.complete
    chat._client.complete = fake_complete
    chat._tools.execute_lookup = lambda args, src: [{"name": "twintails", "post_count": 1, "category_name": "general", "aliases": []}]
    try:
        res = chat.run_chat({"model": "m"}, [{"role": "user", "content": "hi"}],
                            enable_tools=True, sources=[("danbooru", Path("x"))])
        assert "DSML" not in (res["message"]["content"] or "")
        assert len(res["trace"]) == 1 and res["trace"][0]["name"] == "lookup_danbooru_tags"
        assert res["trace"][0]["args"]["limit"] == 10
        assert not res["capped"]
        print("ok: DSML tool call recovered + executed in loop")
    finally:
        chat._client.complete = orig


if __name__ == "__main__":
    test_anima_seed_adds_variants_idempotently()
    test_web_search_dispatch_in_tool_loop()
    test_ddg_html_parsing()
    test_dsml_parse_and_strip()
    test_dsml_recovered_in_tool_loop()
