# T53 — PLv3 HTTP routes (mock request objects, no server needed)
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import routes


class MockRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def post(payload):
    resp = asyncio.run(routes._post_compile(MockRequest(payload)))
    return resp.status, json.loads(resp.body.decode())


def test_compile_returns_text_and_segments():
    status, body = post({"text": "1girl, {a, b}.set{weight: 1.2}"})
    assert status == 200
    assert body["ok"] is True
    assert body["text"] == "1girl, (a, b:1.2)"
    assert body["diagnostics"] == []
    assert [s["kind"] for s in body["segments"]] == ["base"]


def test_segments_carry_the_region_the_user_wrote():
    # the preview names its tabs from these; without them it can only fall back on
    # the segment index, and `imask: 0` would show up as "imask 1"
    _, body = post({"text": "q, {a}.set{region: {imask: 3, feather: 8}}"})
    seg = body["segments"][0]
    assert seg["kind"] == "imask" and seg["imask"] == 3 and seg["feather"] == 8


def test_region_mode_selects_the_backend():
    src = "q, {x}.set{region: {imask: 0}}"
    _, couple = post({"text": src, "region_mode": "couple"})
    _, masked = post({"text": src, "region_mode": "mask"})
    assert couple["text"] == "COUPLE IMASK(0, 1) q, x"
    assert masked["text"] == "IMASK(0, 1) q, x"


def test_unknown_region_mode_falls_back_instead_of_failing():
    status, body = post({"text": "a", "region_mode": "bogus"})
    assert status == 200 and body["ok"] is True


def test_negative_polarity_strips_regions_and_warns():
    _, body = post({"text": "bad, {x}.set{region: {imask: 0}}", "polarity": "negative"})
    assert body["text"] == "bad, x"
    assert [d["code"] for d in body["diagnostics"]] == ["W13"]
    assert body["diagnostics"][0]["severity"] == "warning"


def test_warnings_come_back_with_positions_for_the_squiggles():
    _, body = post({"text": "{a}.set{bogus: 1}"})
    diag = body["diagnostics"][0]
    assert diag["code"] == "W07"
    assert diag["severity"] == "warning"
    assert isinstance(diag["pos"], int)


def test_a_compile_error_is_a_200_with_an_error_marker_not_a_500():
    # the editor needs the marker to point at the bad character; an HTTP failure
    # would just make the squiggle disappear
    status, body = post({"text": "{unclosed"})
    assert status == 200
    assert body["ok"] is False
    assert body["diagnostics"][0]["code"] == "E03"
    assert body["diagnostics"][0]["severity"] == "error"


def test_compile_route_still_returns_the_output_it_could_produce():
    # The editor's route parses in recovering mode: the broken construct is reported,
    # and everything around it still compiles. A preview that goes blank on a missing
    # brace is a preview that is blank most of the time you are editing.
    status, body = post({"text": "masterpiece, { detailed\n\n1girl, smile"})
    assert status == 200
    assert body["ok"] is False                      # the squiggle is still there
    assert "masterpiece" in body["text"]            # ... and so is the output
    assert "1girl" in body["text"] and "smile" in body["text"]


def test_malformed_body_is_a_400():
    status, _ = post(ValueError("not json"))
    assert status == 400


def test_empty_text_is_fine():
    status, body = post({"text": ""})
    assert status == 200 and body["text"] == ""


def ast(payload):
    resp = asyncio.run(routes._post_ast(MockRequest(payload)))
    return resp.status, json.loads(resp.body.decode())


def test_ast_route_returns_a_tree_with_spans():
    src = "1girl, {a, b}.set{weight: 1.2}"
    status, body = ast({"text": src})
    assert status == 200 and body["ok"] is True
    kids = body["ast"]["children"]
    assert [k["kind"] for k in kids] == ["text", "group"]
    assert src[slice(*kids[0]["span"])] == "1girl"
    assert src[slice(*kids[1]["spans"]["set_body"])] == "weight: 1.2"


def test_ast_route_still_returns_the_tree_when_compile_would_abort():
    # E01 (nested regions) is a *compile* error, but the detail page must still be
    # able to show the tree so the user can fix it
    src = "{ {b}.set{region: {imask: 1}} }.set{region: base}"
    _, compiled = post({"text": src})
    assert compiled["ok"] is False and compiled["diagnostics"][0]["code"] == "E01"

    status, tree = ast({"text": src})
    assert status == 200 and tree["ok"] is True
    assert tree["ast"]["children"][0]["settings"]["region"]["kind"] == "base"


def test_ast_route_reports_the_break_but_still_hands_back_a_tree():
    # `ok: false` says "there is an error"; the tree says "here is everything I could
    # still read". The detail page needs both — it shows the tree and flags the error.
    status, body = ast({"text": "1girl, {unclosed\n\nmasterpiece"})
    assert status == 200
    assert body["ok"] is False
    assert body["diagnostics"][0]["code"] == "E03"
    assert body["ast"] is not None and body["ast"]["children"]


def test_monaco_is_vendored_where_the_route_expects_it():
    assert (routes._MONACO_DIR / "vs" / "loader.js").is_file()
    assert (routes._MONACO_DIR / "vs" / "editor" / "editor.main.js").is_file()
    assert (routes._MONACO_DIR / "vs" / "base" / "worker" / "workerMain.js").is_file()
