"""Manual live integration test of the SSE streaming route end-to-end.

Spins up a real aiohttp app with the /xyz/llm/* routes, a TEMP repo DB (so the real
library isn't touched) but the REAL settings file (so the saved DeepSeek key is used),
creates a conversation, POSTs {stream:true}, reads the SSE stream, and verifies the
assistant turn (with reasoning) was persisted. Run: python test/manual/llm_stream_live.py
"""
import asyncio
import io
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from aiohttp import web, ClientSession
from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
import llm.routes as routes


async def main():
    tmp = tempfile.mkdtemp(prefix="llm_stream_")
    db = Path(tmp) / "plv2.db"
    c = connect_write(db); migrate(c); c.close()
    repo.init(db)  # temp DB; real llm_settings.json (with the key) is left as-is

    class FakeServer:  # PromptServer-shaped: just needs `.routes`
        routes = web.RouteTableDef()
    routes.register(FakeServer)
    app = web.Application()
    app.add_routes(FakeServer.routes)
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 8771); await site.start()

    cid = repo.enqueue_write(repo.MID, repo.CreateConversationOp(title="stream test")).result(timeout=5)

    try:
        async with ClientSession() as s:
            async with s.post("http://127.0.0.1:8771/xyz/llm/chat", json={
                "conversation_id": cid, "base_prompt": "",
                "user_request": "用一句话介绍京都。", "stream": True,
            }) as resp:
                print("HTTP", resp.status, resp.headers.get("Content-Type"))
                counts = {"reasoning": 0, "content": 0, "tool": 0, "done": 0, "round_reset": 0, "error": 0}
                done_ev = None
                buf = ""
                async for raw in resp.content:
                    buf += raw.decode("utf-8", "replace")
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        data = "".join(l[5:] for l in block.split("\n") if l.startswith("data:"))
                        if not data.strip():
                            continue
                        ev = json.loads(data.strip())
                        counts[ev["type"]] = counts.get(ev["type"], 0) + 1
                        if ev["type"] == "done":
                            done_ev = ev
                print("event counts:", counts)
                if done_ev:
                    print("done content:", done_ev["message"]["content"][:120])
                    print("done reasoning chars:", len(done_ev.get("reasoning") or ""))
                    print("assistant_msg_id in done:", done_ev.get("assistant_msg_id"))

        # verify persistence (reasoning saved in meta)
        msgs = repo.get_messages(cid)
        asst = [m for m in msgs if m["role"] == "assistant"]
        print("persisted assistant turns:", len(asst))
        if asst:
            meta = asst[-1].get("meta") or {}
            print("persisted content:", (asst[-1]["content"] or "")[:120])
            print("persisted reasoning chars:", len(meta.get("reasoning") or ""))
    finally:
        await runner.cleanup()
        repo.stop()


asyncio.run(main())
