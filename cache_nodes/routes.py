"""`/xyz/cache/...` — what the cache nodes' JS talks to.

The slots live on local disk, so listing them is instant; the frontend re-reads
them whenever it needs to, rather than trusting the list ComfyUI built at startup.
"""

from __future__ import annotations

from aiohttp import web

from .nodes import IMAGE_NAME, create_slot, delete_slot, describe_slots, slot_path


def register(server) -> None:
    routes = server.routes

    @routes.get("/xyz/cache/slots")
    async def cache_slots(request):
        return web.json_response({"ok": True, "slots": describe_slots()})

    @routes.get("/xyz/cache/image")
    async def cache_image(request):
        name = request.query.get("slot", "")
        try:
            target = slot_path(name) / IMAGE_NAME
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

        if not target.is_file():
            return web.json_response(
                {"ok": False, "error": f"slot '{name}' holds no image"}, status=404
            )
        # The file is replaced in place, so the browser must not serve a stale copy.
        # (The frontend also cache-busts with the mtime; belt and braces.)
        return web.FileResponse(
            target, headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
        )

    @routes.post("/xyz/cache/slot")
    async def cache_create(request):
        payload = await request.json()
        try:
            return web.json_response({"ok": True, "slot": create_slot(payload.get("name", ""))})
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.delete("/xyz/cache/slot")
    async def cache_delete(request):
        name = request.query.get("slot", "")
        try:
            return web.json_response({"ok": True, "slot": delete_slot(name)})
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
