"""``metadata._derive_from_workflow`` — node picking and prompt tracing.

The old implementation took the FIRST node whose ``class_type`` contained a
hint. On a real library that meant:

* ``VAELoader`` matched the broad ``Loader`` hint and beat the actual
  ``UNETLoader``, so ``model`` came out empty on ~89% of sampled graphs;
* ``SamplerCustomAdvanced`` matched ``Sampler`` and has nothing but links, so
  the search stopped there and seed / steps / sampler were lost;
* conditioning routed through a pipe or a guider was never followed, so the
  positive prompt was empty on 100% of sampled graphs.

Every test below is a graph shape taken from the author's own library.

Run:
    pytest test/t66_metadata_derive_test.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from gallery import metadata as m  # noqa: E402


def node(class_type, **inputs):
    return {"class_type": class_type, "inputs": inputs}


def link(node_id, slot=0):
    return [str(node_id), slot]


# ---------------------------------------------------------------------------
# the classic KSampler graph must derive exactly what it always did
# ---------------------------------------------------------------------------

CLASSIC = {
    "1": node("CheckpointLoaderSimple", ckpt_name="waiANIMA_v10.safetensors"),
    "2": node("CLIPTextEncode", text="1girl, solo", clip=link(1, 1)),
    "3": node("CLIPTextEncode", text="worst quality", clip=link(1, 1)),
    "4": node(
        "KSampler", seed=42, steps=20, cfg=7.0,
        sampler_name="euler", scheduler="normal",
        model=link(1), positive=link(2), negative=link(3),
    ),
}


def test_a_classic_ksampler_graph_is_unchanged():
    out = m._derive_from_workflow(CLASSIC)
    assert out["model"] == "waiANIMA_v10.safetensors"
    assert out["seed"] == 42
    assert out["steps"] == 20
    assert out["cfg"] == 7.0
    assert out["sampler"] == "euler"
    assert out["scheduler"] == "normal"
    assert out["positive_prompt"] == "1girl, solo"
    assert out["negative_prompt"] == "worst quality"


# ---------------------------------------------------------------------------
# a broad hint must not shadow a specific one
# ---------------------------------------------------------------------------

def test_vaeloader_does_not_shadow_the_real_unet_loader():
    """The single highest-impact bug: ``VAELoader`` matches ``Loader`` and only
    carries ``vae_name``, so under first-match-wins the model was lost."""
    graph = {
        "1": node("VAELoader", vae_name="sdxl_vae.safetensors"),
        "2": node("UNETLoader", unet_name="flux1-dev.safetensors"),
    }
    assert m._derive_from_workflow(graph)["model"] == "flux1-dev.safetensors"


def test_a_model_patcher_node_does_not_shadow_the_loader():
    graph = {
        "1": node("ApplyFBCacheOnModel", object_to_patch="diffusion_model",
                  residual_diff_threshold=0.12, model=link(2)),
        "2": node("CheckpointLoaderSimple", ckpt_name="anima.safetensors"),
    }
    assert m._derive_from_workflow(graph)["model"] == "anima.safetensors"


def test_a_checkpoint_wins_over_a_unet_loader_when_both_exist():
    # Hint order is priority order; ``Checkpoint`` is the more specific claim.
    graph = {
        "1": node("UNETLoader", unet_name="unet.safetensors"),
        "2": node("CheckpointLoaderSimple", ckpt_name="ckpt.safetensors"),
    }
    assert m._derive_from_workflow(graph)["model"] == "ckpt.safetensors"


def test_a_lora_loader_is_not_mistaken_for_the_model():
    graph = {
        "1": node("LoraLoaderModelOnly", lora_name="detail.safetensors",
                  strength_model=1.0),
        "2": node("UNETLoader", unet_name="real.safetensors"),
    }
    assert m._derive_from_workflow(graph)["model"] == "real.safetensors"


def test_no_model_anywhere_is_reported_as_absent_not_guessed():
    graph = {"1": node("VAELoader", vae_name="v.safetensors")}
    assert "model" not in m._derive_from_workflow(graph)


# ---------------------------------------------------------------------------
# SamplerCustomAdvanced — scalars live in sibling nodes
# ---------------------------------------------------------------------------

ADVANCED = {
    "1": node("UNETLoader", unet_name="flux1-dev.safetensors"),
    "2": node("CLIPTextEncode", text="a cat on a mat", clip=link(9)),
    "3": node("RandomNoise", noise_seed=123456789),
    "4": node("KSamplerSelect", sampler_name="euler"),
    "5": node("BasicScheduler", steps=8, scheduler="simple",
              model=link(1), denoise=1.0),
    "6": node("BasicGuider", model=link(1), conditioning=link(2)),
    "7": node("SamplerCustomAdvanced", noise=link(3), guider=link(6),
              sampler=link(4), sigmas=link(5), latent_image=link(8)),
    "8": node("EmptyLatentImage", width=1024, height=1024, batch_size=1),
    "9": node("CLIPLoader", clip_name="t5.safetensors"),
}


def test_the_advanced_sampler_family_is_read_from_its_sibling_nodes():
    out = m._derive_from_workflow(ADVANCED)
    assert out["seed"] == 123456789
    assert out["steps"] == 8
    assert out["sampler"] == "euler"
    assert out["scheduler"] == "simple"
    assert out["model"] == "flux1-dev.safetensors"


def test_conditioning_is_followed_through_a_guider():
    assert m._derive_from_workflow(ADVANCED)["positive_prompt"] == "a cat on a mat"


def test_a_distilled_graph_with_no_cfg_reports_no_cfg():
    # Turbo / distilled models genuinely have none — absent beats invented.
    assert "cfg" not in m._derive_from_workflow(ADVANCED)


# ---------------------------------------------------------------------------
# Impact Pack — conditioning behind a basic_pipe
# ---------------------------------------------------------------------------

PIPE = {
    "1": node("CheckpointLoaderSimple", ckpt_name="wai.safetensors"),
    "2": node("ImpactWildcardProcessor",
              wildcard_text="1girl, __artist__",
              populated_text="1girl, artist:yd", mode=False, seed=1),
    "3": node("StringInput|cgem156", text="worst quality, bad anatomy"),
    "4": node("CLIPTextEncode", text=link(2), clip=link(1, 1)),
    "5": node("CLIPTextEncode", text=link(3), clip=link(1, 1)),
    "6": node("ToBasicPipe", model=link(1), clip=link(1, 1),
              vae=link(1, 2), positive=link(4), negative=link(5)),
    "7": node("FromBasicPipe_v2", basic_pipe=link(6)),
    "8": node("ImpactKSamplerBasicPipe", seed=818300874, steps=10, cfg=5.5,
              sampler_name="euler_ancestral", scheduler="normal",
              denoise=1.0, basic_pipe=link(7), latent_image=link(9)),
    "9": node("EmptyLatentImage", width=832, height=1216, batch_size=1),
}


def test_prompts_are_traced_through_the_pipe_chain():
    out = m._derive_from_workflow(PIPE)
    assert out["positive_prompt"] == "1girl, artist:yd"
    assert out["negative_prompt"] == "worst quality, bad anatomy"


def test_the_resolved_wildcard_text_wins_over_the_pattern():
    # ``populated_text`` is what actually generated the picture;
    # ``wildcard_text`` still holds the unexpanded ``__artist__``.
    assert "__artist__" not in m._derive_from_workflow(PIPE)["positive_prompt"]


def test_the_pipe_graph_still_yields_its_scalars():
    out = m._derive_from_workflow(PIPE)
    assert out["seed"] == 818300874
    assert out["steps"] == 10
    assert out["model"] == "wai.safetensors"


# ---------------------------------------------------------------------------
# the role must survive the walk
# ---------------------------------------------------------------------------

def test_a_negative_chain_never_crosses_into_the_positive_branch():
    """The one way a generic graph walk produces confidently WRONG metadata:
    reporting the positive prompt as the negative one."""
    out = m._derive_from_workflow(PIPE)
    assert out["positive_prompt"] != out["negative_prompt"]


def test_role_named_text_fields_are_picked_apart():
    graph = {
        "1": node("CheckpointLoaderSimple", ckpt_name="m.safetensors"),
        "2": node("SomePackDualEncode",
                  text_positive="good stuff", text_negative="bad stuff",
                  clip=link(1, 1)),
        "3": node("KSampler", seed=1, steps=1, cfg=1.0,
                  sampler_name="euler", scheduler="normal",
                  model=link(1), positive=link(2), negative=link(2, 1)),
    }
    out = m._derive_from_workflow(graph)
    assert out["positive_prompt"] == "good stuff"
    assert out["negative_prompt"] == "bad stuff"


def test_a_cycle_cannot_hang_the_walk():
    graph = {
        "1": node("CheckpointLoaderSimple", ckpt_name="m.safetensors"),
        "2": node("PassThrough", text=link(3)),
        "3": node("PassThrough", text=link(2)),
        "4": node("KSampler", seed=1, steps=1, cfg=1.0,
                  sampler_name="euler", scheduler="normal",
                  model=link(1), positive=link(2), negative=link(3)),
    }
    out = m._derive_from_workflow(graph)  # must return, not recurse forever
    assert "positive_prompt" not in out


# ---------------------------------------------------------------------------
# shape guards
# ---------------------------------------------------------------------------

def test_a_ui_graph_is_still_skipped():
    # The UI form is {"nodes": [...], "links": [...]}, not {id: {class_type}}.
    assert m._derive_from_workflow({"nodes": [], "links": []}) == {}


def test_an_empty_graph_derives_nothing():
    assert m._derive_from_workflow({}) == {}
