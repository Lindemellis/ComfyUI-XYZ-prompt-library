"""Chat engine — the server-side tool-calling loop (synchronous; run in an executor).

Non-streaming. If the model returns tool_calls, the lookup tool runs and results are
fed back, up to MAX_ITERS rounds; on hitting the cap we re-call once WITHOUT tools to
force a final answer (never error out). The full tool trace is returned so the route can
persist tool messages and the UI can fold them ("🔎 looked up N tags").
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import client as _client
from . import tools as _tools

logger = logging.getLogger("xyz.llm.chat")

MAX_ITERS = 4


def run_chat(
    settings: Dict[str, Any],
    messages: List[Dict[str, Any]],
    *,
    enable_tools: bool,
    sources: Optional[List[Tuple[str, Path]]] = None,
    should_abort=None,
) -> Dict[str, Any]:
    """Run the loop. `messages` is mutated with intermediate turns. Returns:

        {message, usage, model, trace: [{name, args, results}], capped: bool}

    `should_abort` (optional callable) is checked between rounds — return True to stop
    early (client disconnected); raises ChatAborted.
    """
    tool_schema = [_tools.LOOKUP_TOOL_SCHEMA] if enable_tools else None
    src = sources or []
    trace: List[Dict[str, Any]] = []
    last_usage = None
    last_model = settings.get("model")

    for _ in range(MAX_ITERS):
        if should_abort and should_abort():
            raise ChatAborted()
        result = _client.complete(settings, messages, tools=tool_schema)
        last_usage = result.get("usage")
        last_model = result.get("model")
        msg = result["message"]
        tool_calls = msg.get("tool_calls") if isinstance(msg, dict) else None

        if not (tool_calls and tool_schema):
            return {
                "message": msg,
                "usage": last_usage,
                "model": last_model,
                "trace": trace,
                "capped": False,
            }

        # Append the assistant turn that requested the tools, then each tool result.
        messages.append(msg)
        for tc in tool_calls:
            fn = (tc.get("function") or {})
            name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            if name == _tools.LOOKUP_TOOL_NAME:
                results = _tools.execute_lookup(args, src)
            else:
                results = []
            trace.append({"name": name, "args": args, "results": results})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id"),
                "content": json.dumps(results, ensure_ascii=False),
            })

    # Hit the cap: force a final answer without tools.
    if should_abort and should_abort():
        raise ChatAborted()
    final = _client.complete(settings, messages, tools=None)
    return {
        "message": final["message"],
        "usage": final.get("usage") or last_usage,
        "model": final.get("model") or last_model,
        "trace": trace,
        "capped": True,
    }


class ChatAborted(Exception):
    """Raised when the loop is stopped early (client disconnected)."""
