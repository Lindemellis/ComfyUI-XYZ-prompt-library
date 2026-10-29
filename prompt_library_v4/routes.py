"""Stateless editing endpoints; snapshots/history belong to the host session."""
from aiohttp import web
from ._v3 import PLv3Error
from .commands import command_response
from .compiler import compile_document
from .model import CommandError, EditorState, projection


def dispatch(operation, body):
    if not isinstance(body, dict):
        raise CommandError("invalid_request", "request must be an object")
    if operation == "open":
        state = EditorState.create(body.get("text"), body.get("doc"), body.get("scope", "document"))
        return dict(ok=True, state=state.to_json(), projection=projection(state))
    state = EditorState.from_json(body["state"])
    if operation == "command":
        return command_response(state, body["command"])
    if operation == "compile":
        result = compile_document(state, seed=body["seed"], region_mode=body["region_mode"], width=body.get('width'), height=body.get('height'), preview=body.get('preview') is True)
        from .mask_resources import metadata
        result['mask_bundle'] = metadata(result['mask_bundle'])
        return dict(ok=True, **result)
    raise CommandError("unknown_operation", "unknown document operation")


def handler(operation):
    async def post(request):
        try:
            body = await request.json()
            # Independent requests operate on their own complete snapshot.
            import asyncio
            result = await asyncio.to_thread(dispatch, operation, body)
            return web.json_response(result)
        except CommandError as exc:
            return web.json_response(dict(ok=False, code=exc.code, error=str(exc)),
                                     status=409 if exc.code == "stale_revision" else 422)
        except PLv3Error as exc:
            return web.json_response(dict(ok=False, code=exc.diag.code, error=str(exc)), status=422)
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            return web.json_response(dict(ok=False, code="invalid_request", error=str(exc)), status=400)
    return post


post_open = handler("open")
post_command = handler("command")
post_compile = handler("compile")


def register(server):
    if getattr(server, '_xyz_plv4_document_registered', False):
        return
    server.routes.post("/xyz/plv4/document/open")(post_open)
    server.routes.post("/xyz/plv4/document/command")(post_command)
    server.routes.post("/xyz/plv4/document/compile")(post_compile)
    server._xyz_plv4_document_registered = True
