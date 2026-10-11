"""LoRA browser routes: identifiers resolve to configured roots, never request paths."""
import asyncio
from aiohttp import web
from .model import CommandError


def register(server, browser):
    async def handle(request):
        try:
            body = await request.json()
            if not isinstance(body, dict): raise TypeError('request must be an object')
            operation = request.match_info['operation']
            if operation == 'complete': result = await asyncio.to_thread(browser.complete, **body)
            elif operation == 'list': result = await asyncio.to_thread(browser.list, **body)
            elif operation == 'detail': result = await asyncio.to_thread(browser.detail, body['id'], body.get('ensure', False), body.get('import_triggers', False))
            elif operation == 'send': result = await asyncio.to_thread(browser.send, body['id'])
            else: result = await asyncio.to_thread(browser.fetch, body['id'])
            return web.json_response({'ok': True, **result})
        except CommandError as error:
            return web.json_response({'ok': False, 'code': error.code, 'error': str(error)}, status=422)
        except (TypeError, ValueError, KeyError, OSError) as error:
            return web.json_response({'ok': False, 'code': 'invalid_request', 'error': str(error)}, status=400)

    async def image(request):
        try:
            path = await asyncio.to_thread(browser.image, request.match_info['id'], int(request.match_info['index']))
            return web.FileResponse(path, headers={'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'})
        except (CommandError, ValueError, OSError): raise web.HTTPNotFound()

    server.routes.post('/xyz/plv4/loras/{operation:list|complete|detail|send|fetch}')(handle)
    server.routes.get('/xyz/plv4/loras/image/{id}/{index}')(image)
