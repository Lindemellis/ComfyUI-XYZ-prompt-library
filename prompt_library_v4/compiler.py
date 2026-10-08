"""PLv4 execution/preview adapter: one ComfyUI node seed, two existing backends."""
from ._v3 import compile_text
from .model import CommandError, EditorState


def compile_document(state: EditorState, *, seed: int, region_mode: str) -> dict:
    # There is deliberately no editor-owned seed or fallback random draw.
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise CommandError("node_seed_only", "supply the ComfyUI node's resolved integer seed input")
    if region_mode not in ("couple", "mask"):
        raise CommandError("invalid_mode", "region_mode must be couple or mask")
    state.check()
    options = dict(seed=seed, region_mode=region_mode, ignore_group_seeds=True)
    prompt = compile_text(state.text, **options)
    plain = compile_text(state.text, ignore_regions=True, **options)
    return dict(prompt=prompt.text, plain=plain.text, revision=state.revision,
                seed=seed, region_mode=region_mode)
