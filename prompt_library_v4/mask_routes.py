"""Asynchronous Mask Library adapter; all file/SQL/image work runs off-loop."""
import asyncio
from aiohttp import web
from .mask_images import composite, extract, rectangle, png_url
from .mask_resources import preview, resolve, metadata
from .model import CommandError, EditorState, projection


def tree(library, refresh=False):
    snap = library.discover() if refresh else library.snapshot()
    canvases = []
    for canvas in snap['canvases']:
        if canvas['deleted']: continue
        canvas = dict(canvas)
        try:
            if canvas['kind'] == 'rectangle':
                masks = [dict(m, mask=rectangle(m['coordinates'])) for m in canvas['masks']]
            else:
                image = extract(library.path_for(canvas['path'], snap['directories']).read_bytes(), canvas['settings'])
                canvas.update(fingerprint=image['fingerprint'], has_alpha=image['has_alpha'])
                masks = [dict(id=key, name='Alpha' if key == 'alpha' else '#' + key[4:], color='#75a5df' if key == 'alpha' else '#' + key[4:], mask=mask) for key, mask in image['masks'].items()]
                for mask in masks: mask.update(canvas.get('presentation', {}).get(mask['id'], {}))
            canvas['preview'] = png_url(composite(masks))
            canvas['masks'] = [{key: value for key, value in m.items() if key != 'mask'} | dict(preview=png_url(m['mask'])) for m in masks]
        except (ValueError, OSError) as error:
            canvas.update(error=str(error), masks=[])
        canvases.append(canvas)
    return dict(ok=True, directory=snap['directory'], canvases=canvases)


def dispatch(library, operation, body):
    if operation == 'tree': return tree(library, body.get('refresh', False))
    if operation == 'mutate':
        value = library.mutate(body['action'], **{key: value for key, value in body.items() if key != 'action'})
        return dict(ok=True, result=value)
    if operation in ('resolve', 'preview'):
        state = EditorState.from_json(body['state'])
        if operation == 'preview':
            result = preview(state, library)
            result['projection'] = projection(EditorState.from_json(result['state']))
        else:
            state, bundle, diagnostics = resolve(state, library)
            result = dict(ok=True, state=state.to_json(), bundle=metadata(bundle), diagnostics=diagnostics, projection=projection(state))
        return result
    raise ValueError('Unknown Mask Library request.')


def register(server, library):
    if getattr(server, '_xyz_plv4_masks_registered', False): return
    async def handle(request):
        try:
            result = await asyncio.to_thread(dispatch, library, request.match_info['operation'], await request.json())
            return web.json_response(result)
        except (CommandError, ValueError, OSError, TypeError, KeyError) as error:
            code = getattr(error, 'code', 'mask_resource_error')
            return web.json_response(dict(ok=False, code=code, error=str(error)), status=409 if code == 'stale_version' else 422)
    server.routes.post('/xyz/plv4/masks/{operation:tree|mutate|resolve|preview}')(handle)
    server._xyz_plv4_masks_registered = True
