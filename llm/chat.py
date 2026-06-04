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
from . import dsml as _dsml

logger = logging.getLogger("xyz.llm.chat")

MAX_ITERS = 6


def _sanitize_assistant(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Strip reasoning fields before re-feeding an assistant turn into the next round —
    providers (DeepSeek) reject their own `reasoning_content` echoed back in context."""
    if not isinstance(msg, dict):
        return msg
    out = {k: v for k, v in msg.items() if k not in ("reasoning", "reasoning_content")}
    return out


def _execute_tool_calls(tool_calls, src, trace) -> List[Dict[str, Any]]:
    """Run each tool call, append to `trace`, and return the tool-result messages."""
    out: List[Dict[str, Any]] = []
    for tc in tool_calls:
        fn = (tc.get("function") or {})
        name = fn.get("name")
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        if name == _tools.LOOKUP_TOOL_NAME:
            results = _tools.execute_lookup(args, src)
        elif name == _tools.WEB_SEARCH_TOOL_NAME:
            results = _tools.execute_web_search(args)
        else:
            results = []
        trace.append({"name": name, "args": args, "results": results})
        out.append({
            "role": "tool",
            "tool_call_id": tc.get("id"),
            "content": json.dumps(results, ensure_ascii=False),
        })
    return out


def run_chat(
    settings: Dict[str, Any],
    messages: List[Dict[str, Any]],
    *,
    enable_tools: bool,
    sources: Optional[List[Tuple[str, Path]]] = None,
    enable_web_search: bool = False,
    should_abort=None,
) -> Dict[str, Any]:
    """Run the loop. `messages` is mutated with intermediate turns. Returns:

        {message, usage, model, trace: [{name, args, results}], capped: bool}

    `enable_tools` adds the danbooru lookup tool; `enable_web_search` adds the keyless
    web-search tool. `should_abort` (optional callable) is checked between rounds —
    return True to stop early (client disconnected); raises ChatAborted.
    """
    schema: List[Dict[str, Any]] = []
    if enable_tools:
        schema.append(_tools.LOOKUP_TOOL_SCHEMA)
    if enable_web_search:
        schema.append(_tools.WEB_SEARCH_TOOL_SCHEMA)
    tool_schema = schema or None
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

        # Some models (DeepSeek v4) leak tool calls as DSML text in `content` instead of
        # the structured field — recover them so the loop executes them properly.
        if not tool_calls and tool_schema and isinstance(msg, dict):
            msg, dsml_calls = _dsml.extract(msg)
            if dsml_calls:
                tool_calls = dsml_calls

        if not (tool_calls and tool_schema):
            if isinstance(msg, dict):
                msg = dict(msg)
                msg["content"] = _dsml.strip(msg.get("content") or "")
            return {
                "message": msg,
                "usage": last_usage,
                "model": last_model,
                "trace": trace,
                "capped": False,
            }

        # Append the assistant turn that requested the tools, then each tool result.
        messages.append(_sanitize_assistant(msg))
        messages.extend(_execute_tool_calls(tool_calls, src, trace))

    # Hit the cap: force a final answer without tools.
    if should_abort and should_abort():
        raise ChatAborted()
    final = _client.complete(settings, messages, tools=None)
    fmsg = final.get("message") if isinstance(final.get("message"), dict) else {}
    # The forced turn can still leak a DSML tool call (it wanted a tool but had none);
    # honor it once more, then ask again for a real text answer.
    if tool_schema and isinstance(fmsg, dict) and not fmsg.get("tool_calls"):
        fmsg2, dsml_calls = _dsml.extract(fmsg)
        if dsml_calls:
            messages.append(_sanitize_assistant(fmsg2))
            messages.extend(_execute_tool_calls(dsml_calls, src, trace))
            final = _client.complete(settings, messages, tools=None)
            fmsg = final.get("message") if isinstance(final.get("message"), dict) else {}
    clean = dict(fmsg) if isinstance(fmsg, dict) else {"role": "assistant", "content": str(fmsg)}
    clean["content"] = _dsml.strip(clean.get("content") or "")
    return {
        "message": clean,
        "usage": final.get("usage") or last_usage,
        "model": final.get("model") or last_model,
        "trace": trace,
        "capped": True,
    }


def run_chat_stream(
    settings: Dict[str, Any],
    messages: List[Dict[str, Any]],
    *,
    enable_tools: bool,
    sources: Optional[List[Tuple[str, Path]]] = None,
    enable_web_search: bool = False,
    should_abort=None,
):
    """Streaming tool loop — a generator of events for an SSE endpoint:

      {"type":"reasoning"|"content","delta":str}  — live token deltas
      {"type":"round_reset"}                        — a tool round starts; clear streamed content
      {"type":"tool","name","args","results"}       — a tool ran
      {"type":"done","message":{role,content},"reasoning",str,"trace",[...],"capped",bool,
                     "usage","model"}                — final (exactly once)

    Mirrors run_chat (DSML recovery, tool execution, cap→force-final) but streams."""
    schema: List[Dict[str, Any]] = []
    if enable_tools:
        schema.append(_tools.LOOKUP_TOOL_SCHEMA)
    if enable_web_search:
        schema.append(_tools.WEB_SEARCH_TOOL_SCHEMA)
    tool_schema = schema or None
    src = sources or []
    trace: List[Dict[str, Any]] = []
    reasoning_total: List[str] = []
    last_usage = None
    last_model = settings.get("model")

    def _drive(msgs, tools):
        """Inner generator: passthrough reasoning/content deltas, capture the result."""
        holder: Dict[str, Any] = {}
        def gen():
            for ev in _client.complete_stream(settings, msgs, tools=tools):
                if ev["type"] == "result":
                    holder["result"] = ev
                elif ev["type"] == "reasoning":
                    reasoning_total.append(ev["delta"]); yield ev
                elif ev["type"] == "content":
                    yield ev
        return gen(), holder

    for _ in range(MAX_ITERS):
        if should_abort and should_abort():
            raise ChatAborted()
        g, holder = _drive(messages, tool_schema)
        yield from g
        result = holder.get("result") or {"message": {"role": "assistant", "content": ""}}
        last_usage = result.get("usage") or last_usage
        last_model = result.get("model") or last_model
        msg = result["message"]
        tool_calls = msg.get("tool_calls")
        if not tool_calls and tool_schema and isinstance(msg, dict):
            msg, dsml_calls = _dsml.extract(msg)
            if dsml_calls:
                tool_calls = dsml_calls

        if not (tool_calls and tool_schema):
            yield {"type": "done",
                   "message": {"role": "assistant", "content": _dsml.strip(msg.get("content") or "")},
                   "reasoning": "".join(reasoning_total), "trace": trace, "capped": False,
                   "usage": last_usage, "model": last_model}
            return

        # tool round — the streamed content was a preamble (or junk DSML); clear it client-side
        yield {"type": "round_reset"}
        messages.append(_sanitize_assistant(msg))
        for tc in tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            if name == _tools.LOOKUP_TOOL_NAME:
                results = _tools.execute_lookup(args, src)
            elif name == _tools.WEB_SEARCH_TOOL_NAME:
                results = _tools.execute_web_search(args)
            else:
                results = []
            trace.append({"name": name, "args": args, "results": results})
            yield {"type": "tool", "name": name, "args": args, "results": results}
            messages.append({"role": "tool", "tool_call_id": tc.get("id"),
                             "content": json.dumps(results, ensure_ascii=False)})

    # Cap: force a final answer without tools (still streamed).
    if should_abort and should_abort():
        raise ChatAborted()
    g, holder = _drive(messages, None)
    yield from g
    result = holder.get("result") or {"message": {"role": "assistant", "content": ""}}
    fmsg = result["message"]
    if tool_schema and isinstance(fmsg, dict) and not fmsg.get("tool_calls"):
        fmsg2, dsml_calls = _dsml.extract(fmsg)
        if dsml_calls:
            yield {"type": "round_reset"}
            messages.append(_sanitize_assistant(fmsg2))
            messages.extend(_execute_tool_calls(dsml_calls, src, trace))
            for t in trace[-len(dsml_calls):]:
                yield {"type": "tool", "name": t["name"], "args": t["args"], "results": t["results"]}
            g, holder = _drive(messages, None)
            yield from g
            result = holder.get("result") or result
            fmsg = result["message"]
    yield {"type": "done",
           "message": {"role": "assistant", "content": _dsml.strip(fmsg.get("content") or "")},
           "reasoning": "".join(reasoning_total), "trace": trace, "capped": True,
           "usage": result.get("usage") or last_usage, "model": result.get("model") or last_model}


class ChatAborted(Exception):
    """Raised when the loop is stopped early (client disconnected)."""
