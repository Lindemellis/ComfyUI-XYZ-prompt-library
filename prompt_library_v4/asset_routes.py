"""Library HTTP adapter; no SQL or blocking work on the event loop."""
import asyncio
from aiohttp import web
from .model import CommandError
from ._v3 import PLv3Error


def register(server, library, legacy_source=None):
    async def handle(request):
        try:
            body = await request.json()
            if not isinstance(body, dict): raise TypeError('request must be an object')
            operation = request.match_info['operation']
            if operation == 'migrate':
                if legacy_source is None: raise CommandError('missing_v3', '未配置 V3 来源')
                from .migrate_v3 import migrate
                result = await asyncio.to_thread(migrate, legacy_source, library)
            else:
                result = await asyncio.to_thread(library.mutate, body) if operation == 'mutate' else await asyncio.to_thread(library.read, body.pop('action', 'tree'), **body)
            return web.json_response({'ok': True, **result})
        except CommandError as error:
            return web.json_response({'ok': False, 'code': error.code, 'error': str(error)}, status=409 if error.code in ('asset_conflict', 'asset_in_use', 'duplicate_tag', 'placement_cycle') else 422)
        except PLv3Error as error:
            return web.json_response({'ok': False, 'code': error.diag.code, 'error': str(error)}, status=422)
        except (KeyError, ValueError, TypeError, AttributeError) as error:
            return web.json_response({'ok': False, 'code': 'invalid_request', 'error': str(error)}, status=400)
    server.routes.post('/xyz/plv4/library/{operation:read|mutate|migrate}')(handle)
