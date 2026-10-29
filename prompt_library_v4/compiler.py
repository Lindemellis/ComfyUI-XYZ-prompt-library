"""PLv4 execution/preview adapter: one ComfyUI node seed, two existing backends."""
from copy import deepcopy
from ._v3 import compile_text
from .model import CommandError, EditorState, pair_tree
from ._v3 import parse


def lora_positions(state):
    root, _ = parse(state.text)
    index = {}
    pair_tree(state.doc.root, root, index, visible=True)
    return [index[node.id].pos for node in state.doc.root.walk() if node.id in index and node.meta.get('lora') and node.children and node.children[0].enabled]


def bypass_region_paths(state):
    disabled = [node for node in state.doc.root.walk() if node.form == 'region' and node.meta.get('region_enabled') is False]
    if not disabled:
        return ()
    root, _ = parse(state.text)
    index = {}
    pair_tree(state.doc.root, root, index, visible=True)
    return tuple(index[node.id].path for node in disabled if node.id in index)


def compile_document(state: EditorState, *, seed: int, region_mode: str, include_metadata=False, mask_library=None, width=None, height=None, preview=False) -> dict:
    # There is deliberately no editor-owned seed or fallback random draw.
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise CommandError("node_seed_only", "supply the ComfyUI node's resolved integer seed input")
    if region_mode not in ("couple", "mask"):
        raise CommandError("invalid_mode", "region_mode must be couple or mask")
    state.check()
    from .output_policy import options as output_options
    config = output_options(state.doc)
    if config['output_mode'] not in ('prompt_control', 'moss'):
        raise CommandError('invalid_output_mode', 'Unknown PLV4 output mode')
    from .mask_resources import resolve, metadata as mask_metadata
    state, bundle, _ = resolve(state, mask_library)
    if config['output_mode'] == 'moss':
        from .moss import compile_moss
        compiled = compile_moss(state, seed, width, height, preview=preview)
        result = dict(prompt=compiled['prompt'], plain=compiled['plain'], revision=state.revision,
                      seed=seed, region_mode=region_mode, output_mode='moss',
                      diagnostics=compiled['diagnostics'], mask_bundle=bundle)
        result.update(preview_only=compiled['preview_only'], preview_notice=compiled['preview_notice'])
        # Provisional coordinates are editor output, never an executable/savable snapshot.
        if include_metadata and not compiled['preview_only']:
            if '.' in __package__:
                from ..prompt_shared.image_metadata import PROMPT_SCHEMA, lora_records
            else:
                from prompt_shared.image_metadata import PROMPT_SCHEMA, lora_records
            result['metadata'] = dict(schema=PROMPT_SCHEMA, version=1, source=state.text,
                document=deepcopy(state.doc.to_json()), prompt=result['prompt'], plain=result['plain'],
                prompt_loras=lora_records(compiled['loras']), plain_loras=lora_records(compiled['loras']),
                seed=str(seed), region_mode=region_mode, compiler_policy='plv4', output_mode='moss',
                moss=compiled['moss'], mask_resources=mask_metadata(bundle))
        return result
    options = dict(seed=seed, region_mode=region_mode, ignore_group_seeds=True,
                   centralize_loras=True, lora_block_positions=lora_positions(state),
                   bypass_region_paths=bypass_region_paths(state))
    prompt = compile_text(state.text, **options)
    plain = compile_text(state.text, ignore_regions=True, **options)
    if config['sentence_case']:
        from .sentence_case import sentence_case
        prompt.text = sentence_case(prompt.text)
        plain.text = sentence_case(plain.text)
    result = dict(prompt=prompt.text, plain=plain.text, revision=state.revision,
                  seed=seed, region_mode=region_mode)
    result['mask_bundle'] = bundle
    if include_metadata:
        if '.' in __package__:
            from ..prompt_shared.image_metadata import PROMPT_SCHEMA, lora_records
        else:
            from prompt_shared.image_metadata import PROMPT_SCHEMA, lora_records
        result['metadata'] = dict(schema=PROMPT_SCHEMA, version=1,
            source=state.text, document=deepcopy(state.doc.to_json()), prompt=prompt.text,
            plain=plain.text, prompt_loras=lora_records(prompt.loras),
            plain_loras=lora_records(plain.loras), seed=str(seed),
            region_mode=region_mode, compiler_policy='plv4')
        result['metadata']['mask_resources'] = mask_metadata(bundle)
    return result
