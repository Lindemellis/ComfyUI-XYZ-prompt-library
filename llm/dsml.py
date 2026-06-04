"""Parse DeepSeek's leaked tool-call markup ("DSML").

Some DeepSeek models (notably deepseek-v4-pro) don't always return tool calls in the
standard OpenAI `message.tool_calls` field — they sometimes serialize the call into the
assistant `content` using a Claude-style XML format wrapped in full-width `｜｜DSML｜｜`
tokens, e.g.:

    <｜｜DSML｜｜tool_calls>
    <｜｜DSML｜｜invoke name="lookup_danbooru_tags">
    <｜｜DSML｜｜parameter name="limit" string="false">10</｜｜DSML｜｜parameter>
    <｜｜DSML｜｜parameter name="queries" string="false">["a","b"]</｜｜DSML｜｜parameter>
    </｜｜DSML｜｜invoke>
    </｜｜DSML｜｜tool_calls>

This module detects that markup, converts it into OpenAI-shaped tool_calls so the normal
tool loop can execute it, and strips it out of any text shown to the user.

`string="true"` means the parameter value is a literal string; otherwise the value is
parsed as JSON (number / bool / array / object), falling back to the raw string.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Tuple

# `｜` is U+FF5C (fullwidth vertical line); the wrapper is literally `｜｜DSML｜｜`.
_BAR = "｜"
_W = re.escape(_BAR + _BAR + "DSML" + _BAR + _BAR)  # ｜｜DSML｜｜

_INVOKE_RE = re.compile(
    r"<" + _W + r'invoke\s+name="(?P<name>[^"]+)"\s*>(?P<body>.*?)</' + _W + r"invoke>",
    re.DOTALL,
)
_PARAM_RE = re.compile(
    r"<" + _W + r'parameter\s+name="(?P<pname>[^"]+)"(?P<attrs>[^>]*)>(?P<value>.*?)</'
    + _W + r"parameter>",
    re.DOTALL,
)
# the whole tool_calls block (for stripping) + any stray opening/closing DSML tags
_TOOLCALLS_BLOCK_RE = re.compile(
    r"<" + _W + r"tool_calls>.*?</" + _W + r"tool_calls>", re.DOTALL
)
_ANY_TAG_RE = re.compile(r"</?" + _W + r"[^>]*>", re.DOTALL)


def has_dsml(content: str) -> bool:
    return bool(content) and (_BAR + _BAR + "DSML") in content


def _parse_value(value: str, attrs: str) -> Any:
    v = (value or "").strip()
    if 'string="true"' in (attrs or ""):
        return v
    try:
        return json.loads(v)
    except Exception:
        return v


def parse_tool_calls(content: str) -> List[Dict[str, Any]]:
    """Return OpenAI-shaped tool_calls parsed from DSML invoke blocks in `content`."""
    calls: List[Dict[str, Any]] = []
    for i, m in enumerate(_INVOKE_RE.finditer(content or "")):
        name = m.group("name")
        args: Dict[str, Any] = {}
        for p in _PARAM_RE.finditer(m.group("body")):
            args[p.group("pname")] = _parse_value(p.group("value"), p.group("attrs"))
        calls.append({
            "id": f"dsml_{i}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        })
    return calls


def strip(content: str) -> str:
    """Remove DSML tool-call markup from text meant for the user."""
    if not content:
        return content
    out = _TOOLCALLS_BLOCK_RE.sub("", content)
    out = _INVOKE_RE.sub("", out)
    out = _ANY_TAG_RE.sub("", out)
    return out.strip()


def extract(message: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """If `message` has no structured tool_calls but its content carries DSML calls,
    return (rewritten_message_with_tool_calls_and_clean_content, calls). Otherwise return
    (message, [])."""
    if not isinstance(message, dict):
        return message, []
    if message.get("tool_calls"):
        return message, []
    content = message.get("content") or ""
    if not has_dsml(content):
        return message, []
    calls = parse_tool_calls(content)
    if not calls:
        # markup present but unparseable — at least clean it for display
        cleaned = dict(message); cleaned["content"] = strip(content)
        return cleaned, []
    rewritten = dict(message)
    rewritten["content"] = strip(content)
    rewritten["tool_calls"] = calls
    return rewritten, calls
