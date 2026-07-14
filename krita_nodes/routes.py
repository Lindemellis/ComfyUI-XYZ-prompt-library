"""`/xyz/krita/...` — what the node's JS talks to.

The frontend never talks to Krita directly (its port is a different origin and
the plugin binds to localhost); ComfyUI proxies.
"""

from __future__ import annotations

from aiohttp import web

from . import client, installer
from .nodes import DOCUMENT_ENTRY, combo_entry


def _flatten(layers: list[dict], depth: int = 0) -> list[dict]:
    """The layer tree as a flat list, in the order Krita's docker shows it."""
    out = []
    for layer in layers:
        out.append(
            {
                "id": layer["id"],
                "name": layer["name"],
                "type": layer["type"],
                "visible": layer["visible"],
                "is_image": layer["is_image"],
                "is_mask": layer["is_mask"],
                "depth": depth,
                "entry": combo_entry(layer),
            }
        )
        out.extend(_flatten(layer["children"], depth + 1))
    return out


def register(server) -> None:
    routes = server.routes

    @routes.get("/xyz/krita/ping")
    async def krita_ping(request):
        try:
            return web.json_response(client.ping())
        except client.KritaUnreachable as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=503)
        except client.KritaError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.get("/xyz/krita/layers")
    async def krita_layers(request):
        try:
            data = client.layers()
        except client.KritaUnreachable as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=503)
        except client.KritaError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

        flat = _flatten(data.get("layers", []))
        return web.json_response(
            {
                "ok": True,
                "document": data.get("document"),
                "layers": flat,
                # The two combos the frontend fills in. Only Fetch Image can take
                # the whole document; a mask has to come from a specific layer.
                "image_entries": [DOCUMENT_ENTRY]
                + [layer["entry"] for layer in flat if layer["is_image"]],
                "mask_entries": [
                    layer["entry"] for layer in flat if layer["is_image"] or layer["is_mask"]
                ],
            }
        )

    @routes.get("/xyz/krita/plugin")
    async def krita_plugin_status(request):
        return web.json_response(installer.status())

    @routes.post("/xyz/krita/plugin/install")
    async def krita_plugin_install(request):
        try:
            return web.json_response(installer.install())
        except Exception as exc:  # noqa: BLE001 - surfaced to the user as-is
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/xyz/krita/plugin/uninstall")
    async def krita_plugin_uninstall(request):
        try:
            return web.json_response(installer.uninstall())
        except Exception as exc:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
