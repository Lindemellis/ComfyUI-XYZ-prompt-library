"""`/xyz/agent/...` — start and inspect the agent orchestrator.

The sidebar panel probes the bridge on its own and connects the moment it is up,
so these routes only have to get the process running; nothing here talks to the
panel.
"""

from __future__ import annotations

from aiohttp import web

from . import launcher


def register(server) -> None:
    routes = server.routes

    @routes.get("/xyz/agent/status")
    async def agent_status(request):
        return web.json_response(launcher.status())

    @routes.post("/xyz/agent/start")
    async def agent_start(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        wait = bool(body.get("wait", True))
        timeout = float(body.get("timeout", 60.0))
        env = body.get("env") if isinstance(body.get("env"), dict) else None
        try:
            return web.json_response(launcher.launch(wait=wait, timeout=timeout, env_overrides=env))
        except launcher.OrchestratorNotFound as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=404)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/xyz/agent/entry")
    async def agent_entry(request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        path = body.get("path")
        if not path:
            return web.json_response({"ok": False, "error": "path is required"}, status=400)
        try:
            return web.json_response({"ok": True, "entry": launcher.set_entry(str(path))})
        except launcher.OrchestratorNotFound as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.post("/xyz/agent/unlock")
    async def agent_unlock(request):
        """Flip the content note and/or choose which one is in force.

        Live for both lanes with no restart in any case — each re-reads one
        fixed path per turn, and this rewrites what is at that path. Both fields
        are optional so the switch and the dropdown can move independently.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        if "enabled" not in body and "choice" not in body:
            return web.json_response(
                {"ok": False, "error": "enabled or choice is required"}, status=400
            )
        enabled = bool(body["enabled"]) if "enabled" in body else None
        choice = str(body["choice"]) if body.get("choice") else None
        result = launcher.set_unlock(enabled, choice)
        return web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/xyz/agent/providers")
    async def agent_providers(request):
        """The switchable endpoints, which is live, and which have a key."""
        return web.json_response(launcher.list_providers())

    @routes.get("/xyz/agent/models")
    async def agent_models(request):
        """Ask one endpoint what it serves — live, because these catalogues
        change and differ between a provider's China and global hosts."""
        pid = request.rel_url.query.get("provider", "")
        if not pid:
            return web.json_response({"ok": False, "error": "provider is required"}, status=400)
        result = launcher.list_models(pid)
        return web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/xyz/agent/provider")
    async def agent_set_provider(request):
        """Switch the custom lane, then restart so it actually takes effect."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        pid = body.get("provider")
        if not pid:
            return web.json_response({"ok": False, "error": "provider is required"}, status=400)
        try:
            result = launcher.set_provider(str(pid), body.get("model") or None)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/xyz/agent/log")
    async def agent_log(request):
        """The tail of the orchestrator's own log — the only place its startup
        errors go, since it runs detached with no console attached."""
        path = launcher.DATA_DIR / "orchestrator.log"
        try:
            data = path.read_bytes()[-16000:]
            return web.json_response({"ok": True, "log": data.decode("utf-8", "replace")})
        except OSError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=404)
