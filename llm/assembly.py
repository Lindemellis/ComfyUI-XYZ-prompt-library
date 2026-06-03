"""Request assembly — map template blocks to a proper OpenAI `messages` array.

Three-way mapping (locked design §8.4):
  - normal blocks (header/jailbreak/task/format/tooldoc/custom) → one `system` message,
    concatenated in order, `\n\n`-joined, text verbatim;
  - the `history` block → real {user/assistant} turns from the conversation (last N),
    clean text only (tool round-trips stripped to avoid pairing-integrity errors);
  - `base_prompt` + `user_request` (runtime values) → the current `user` message.

Phase 2 omits the verified-tag digest and tools (Phase 6).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

try:  # runtime: subpackage of the custom-node root
    from ..prompt_library_v2 import repo as _repo
except ImportError:  # standalone (tests)
    from prompt_library_v2 import repo as _repo

# Blocks that are NOT plain system text.
_SPECIAL_KINDS = {"history", "base_prompt", "user_request"}

_DIGEST_CAP = 60  # max tags to remind the model about


def verified_tag_digest(conversation_id: Optional[int]) -> str:
    """A deduplicated note of danbooru tags already verified (via tool calls) in this
    conversation, so the model reuses them and avoids re-querying. Empty if none."""
    if not conversation_id:
        return ""
    seen: "dict[str, Any]" = {}
    for m in _repo.get_messages(conversation_id):
        if m.get("role") != "tool":
            continue
        content = m.get("content")
        try:
            results = json.loads(content) if isinstance(content, str) else content
        except Exception:
            continue
        if not isinstance(results, list):
            continue
        for r in results:
            if isinstance(r, dict) and r.get("name") and r["name"] not in seen:
                seen[r["name"]] = r.get("post_count")
    if not seen:
        return ""
    parts = []
    for name, pc in list(seen.items())[:_DIGEST_CAP]:
        parts.append(f"{name} ({pc})" if pc else name)
    return ("[Danbooru tags already verified to exist in this conversation — reuse "
            "freely, no need to look them up again]\n" + ", ".join(parts))


def _clean_history(conversation_id: int, keep_turns: Optional[int]) -> List[Dict[str, str]]:
    """Reconstruct clean user/assistant turns from the stored log.

    Tool messages and assistant `tool_calls` are dropped (we only replay text). A
    "turn" is a user message + its assistant reply, so `keep_turns` keeps the last
    2*N text messages. None = keep all.
    """
    if not conversation_id:
        return []
    msgs = _repo.get_messages(conversation_id)
    clean: List[Dict[str, str]] = []
    for m in msgs:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = (m.get("content") or "").strip()
        if not content:
            continue  # e.g. an assistant turn that was purely tool_calls
        clean.append({"role": role, "content": content})
    if keep_turns is not None and keep_turns >= 0:
        if keep_turns == 0:
            return []
        clean = clean[-(keep_turns * 2):]
    return clean


def build_messages(
    conversation_id: Optional[int],
    base_prompt: str,
    user_request: str,
) -> List[Dict[str, Any]]:
    """Assemble the messages array from the current blocks + conversation history."""
    blocks = _repo.get_llm_blocks()

    system_parts: List[str] = []
    history_block: Optional[Dict[str, Any]] = None
    for b in blocks:
        if not b.get("enabled"):
            continue
        kind = b.get("kind")
        if kind == "history":
            history_block = b
            continue
        if kind in _SPECIAL_KINDS:
            continue  # base_prompt / user_request are filled from runtime values
        text = (b.get("text") or "").strip()
        if text:
            system_parts.append(text)

    digest = verified_tag_digest(conversation_id)
    if digest:
        system_parts.append(digest)

    messages: List[Dict[str, Any]] = []
    if system_parts:
        messages.append({"role": "system", "content": "\n\n".join(system_parts)})

    if history_block is not None and conversation_id:
        messages.extend(_clean_history(conversation_id, history_block.get("keep_turns")))

    user_parts: List[str] = []
    if (base_prompt or "").strip():
        user_parts.append(base_prompt.strip())
    if (user_request or "").strip():
        user_parts.append(user_request.strip())
    messages.append({"role": "user", "content": "\n\n".join(user_parts)})

    return messages
