"""Keep scheduled LoRAs usable with ComfyUI's mixed-precision quantized models.

ComfyUI 0.37.4 exposes quantization sidecars in state_dict but not as module
attributes, and its WeightHook setter path tries an unsupported in-place update.
Install only while those upstream behaviors are present; never edit core files.
"""

import inspect
import logging
from types import SimpleNamespace


_LOG = logging.getLogger(__name__)
_MARKER = "_xyz_quantized_hook_compat"


def install():
    import torch
    import comfy.hooks
    import comfy.lora
    import comfy.model_management
    import comfy.model_patcher as model_patcher
    import comfy.utils
    from comfy.quant_ops import QuantizedTensor

    if getattr(model_patcher.ModelPatcher.patch_hooks, _MARKER, False):
        return False

    # The upstream fix for state_dict-only scale keys can land independently of
    # the setter fix. Probe behavior instead of comparing ComfyUI version strings.
    probe = SimpleNamespace(layer=SimpleNamespace(weight=object()))
    try:
        missing_weight = model_patcher.get_key_weight(probe, "layer.weight_scale")[0]
    except AttributeError:
        missing_weight = object()
    if missing_weight is not None:
        original_get_key_weight = model_patcher.get_key_weight

        def get_key_weight(model, key):
            try:
                return original_get_key_weight(model, key)
            except AttributeError:
                # QuantizedTensor serializes scales and metadata as virtual keys.
                # Preserve errors for a missing module or a failing setter.
                module_path, _, attribute = key.rpartition(".")
                if not module_path:
                    raise
                module = comfy.utils.get_attr(model, module_path)
                if hasattr(module, attribute):
                    raise
                return None, None, None

        setattr(get_key_weight, _MARKER, True)
        model_patcher.get_key_weight = get_key_weight

    original_apply_weight = model_patcher.ModelPatcher.patch_hook_weight_to_device
    expected_signatures = (
        (model_patcher.ModelPatcher.patch_hooks, ("self", "hooks")),
        (original_apply_weight, ("self", "hooks", "combined_patches", "key", "original_weights", "memory_counter")),
        (model_patcher.ModelPatcher.patch_cached_hook_weights, ("self", "cached_weights", "key", "memory_counter")),
        (model_patcher.ModelPatcher.unpatch_hooks, ("self", "whitelist_keys_set")),
    )
    if any(tuple(inspect.signature(method).parameters) != expected for method, expected in expected_signatures):
        _LOG.warning("[XYZ] ComfyUI WeightHook API changed; quantized hook fix skipped")
        return False
    try:
        apply_source = inspect.getsource(original_apply_weight)
    except (OSError, TypeError):
        _LOG.warning("[XYZ] Cannot inspect ComfyUI WeightHook implementation; quantized hook fix skipped")
        return False
    if "set_func(out_weight, inplace_update=True" not in apply_source:
        _LOG.info("[XYZ] ComfyUI WeightHook setter already changed; compatibility fix skipped")
        return False

    original_patch_hooks = model_patcher.ModelPatcher.patch_hooks
    original_cached_weight = model_patcher.ModelPatcher.patch_cached_hook_weights
    original_unpatch_hooks = model_patcher.ModelPatcher.unpatch_hooks

    def patch_hooks(self, hooks):
        try:
            return original_patch_hooks(self, hooks)
        except Exception:
            # A failed group must not be reused as a partial cached group.
            self.cached_hook_patches.pop(hooks, None)
            raise

    def patch_cached_hook_weights(self, cached_weights, key, memory_counter):
        cached_weight, device = cached_weights[key]
        if not isinstance(cached_weight, QuantizedTensor):
            return original_cached_weight(self, cached_weights, key, memory_counter)
        if key not in self.hook_backup:
            weight = comfy.utils.get_attr(self.model, key)
            target_device = self.offload_device
            if self.hook_mode == comfy.hooks.EnumHookMode.MaxSpeed and memory_counter.use(weight):
                target_device = weight.device
            self.hook_backup[key] = (weight.to(device=target_device, copy=True), weight.device)
        # The cached value includes both packed data and quantization metadata.
        comfy.utils.set_attr_param(self.model, key, cached_weight.to(device=device))

    def patch_hook_weight_to_device(self, hooks, combined_patches, key, original_weights, memory_counter):
        weight, set_func, convert_func = model_patcher.get_key_weight(self.model, key)
        if set_func is None:
            return original_apply_weight(self, hooks, combined_patches, key, original_weights, memory_counter)
        if key not in combined_patches:
            return
        if key not in self.hook_backup:
            target_device = self.offload_device
            if self.hook_mode == comfy.hooks.EnumHookMode.MaxSpeed and memory_counter.use(weight):
                target_device = weight.device
            self.hook_backup[key] = (
                weight.to(device=target_device, copy=True), weight.device,
            )
        temp_weight = comfy.model_management.cast_to_device(weight, weight.device, torch.float32, copy=True)
        if convert_func is not None:
            temp_weight = convert_func(temp_weight, inplace=True)
        out_weight = comfy.lora.calculate_weight(
            combined_patches[key], temp_weight, key, original_weights=original_weights,
        )
        del original_weights[key]
        # set_weight builds a new QuantizedTensor with updated scales. Its
        # inplace_update=True path intentionally asserts in ComfyUI 0.37.4.
        set_func(out_weight, inplace_update=False, seed=comfy.utils.string_to_seed(key))
        if self.hook_mode == comfy.hooks.EnumHookMode.MaxSpeed:
            patched_weight = comfy.utils.get_attr(self.model, key)
            target_device = self.offload_device
            if memory_counter.use(patched_weight):
                target_device = patched_weight.device
            self.cached_hook_patches.setdefault(hooks, {})[key] = (
                patched_weight.to(device=target_device, copy=True), patched_weight.device,
            )

    def unpatch_hooks(self, whitelist_keys_set=None):
        # Restore the whole quantized parameter, including its scale metadata.
        # Leave ordinary weights to the original ComfyUI implementation.
        with self.use_ejected():
            for key in list(self.hook_backup):
                if whitelist_keys_set and key not in whitelist_keys_set:
                    continue
                saved_weight, device = self.hook_backup[key]
                if isinstance(saved_weight, QuantizedTensor):
                    comfy.utils.set_attr_param(self.model, key, saved_weight.to(device=device))
                    self.hook_backup.pop(key)
        return original_unpatch_hooks(self, whitelist_keys_set)

    for method in (patch_hooks, patch_cached_hook_weights, patch_hook_weight_to_device, unpatch_hooks):
        setattr(method, _MARKER, True)
    model_patcher.ModelPatcher.patch_hooks = patch_hooks
    model_patcher.ModelPatcher.patch_cached_hook_weights = patch_cached_hook_weights
    model_patcher.ModelPatcher.patch_hook_weight_to_device = patch_hook_weight_to_device
    model_patcher.ModelPatcher.unpatch_hooks = unpatch_hooks
    _LOG.info("[XYZ] Installed quantized WeightHook compatibility for scheduled LoRAs")
    return True
