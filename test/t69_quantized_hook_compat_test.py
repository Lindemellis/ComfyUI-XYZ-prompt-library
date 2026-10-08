"""Regression for scheduled WeightHooks on ComfyUI mixed-precision INT8 weights."""

import gc
from pathlib import Path
import sys
import unittest
from unittest import mock


_PACK = Path(__file__).resolve().parents[1]
_COMFY = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_PACK))
sys.path.insert(0, str(_COMFY))

try:
    import torch
    from comfy.cli_args import args
    args.cpu = True
    from comfy import hooks, model_patcher, ops
    from comfy.quant_ops import QuantizedTensor
    import quantized_hook_compat
except ImportError as exc:
    raise unittest.SkipTest(f"ComfyUI's torch environment is required: {exc}") from exc


def _future_core_weight_hook(self, hooks, combined_patches, key, original_weights, memory_counter):
    """Stand-in for an upstream implementation that no longer uses in-place setters."""


class QuantizedHookCompatTest(unittest.TestCase):
    def test_int8_hook_applies_and_restores_full_weight(self):
        names = ("patch_hooks", "patch_cached_hook_weights", "patch_hook_weight_to_device", "unpatch_hooks")
        original_methods = {name: getattr(model_patcher.ModelPatcher, name) for name in names}
        original_get_key_weight = model_patcher.get_key_weight

        def restore_methods():
            model_patcher.get_key_weight = original_get_key_weight
            for name, method in original_methods.items():
                setattr(model_patcher.ModelPatcher, name, method)

        self.addCleanup(restore_methods)
        quantized_hook_compat.install()

        linear = ops.mixed_precision_ops({}, compute_dtype=torch.bfloat16).Linear(
            16, 4, bias=False, device="cpu",
        )
        original_float = torch.randn(4, 16, dtype=torch.bfloat16)
        linear.weight = torch.nn.Parameter(
            QuantizedTensor.from_float(original_float, "TensorWiseINT8Layout"),
            requires_grad=False,
        )
        linear.quant_format = "int8_tensorwise"
        linear.layout_type = "TensorWiseINT8Layout"
        ordinary = torch.nn.Linear(4, 4, bias=False)
        model = torch.nn.Sequential(linear, ordinary)
        patcher = model_patcher.ModelPatcher(
            model, load_device=torch.device("cpu"), offload_device=torch.device("cpu"),
        )
        original_data = linear.weight._qdata.clone()
        original_scale = linear.weight._params.scale.clone()
        original_ordinary = ordinary.weight.detach().clone()

        # Some ComfyUI builds omit virtual scale keys from state_dict. Resolve
        # the sidecar directly so the check covers both serialization layouts.
        self.assertIsNone(model_patcher.get_key_weight(model, "0.weight_scale")[0])
        self.assertIn("0.weight", patcher.get_key_patches())
        hook = hooks.WeightHook()
        group = hooks.HookGroup()
        group.add(hook)
        patcher.add_hook_patches(
            hook,
            {
                "0.weight": (torch.ones_like(original_float),),
                "1.weight": (torch.ones_like(original_ordinary),),
            },
            strength_patch=0.5,
        )

        with mock.patch.object(
            model_patcher.comfy.lora, "calculate_weight",
            wraps=model_patcher.comfy.lora.calculate_weight,
        ) as calculate_weight:
            for repetition in range(2):
                patcher.patch_hooks(group)
                self.assertEqual(patcher.hook_mode, hooks.EnumHookMode.MaxSpeed)
                self.assertIsInstance(linear.weight, QuantizedTensor)
                self.assertFalse(torch.equal(linear.weight._qdata, original_data))
                self.assertTrue(torch.allclose(ordinary.weight, original_ordinary + 0.5))
                if repetition == 0:
                    first_apply_calls = calculate_weight.call_count
                    self.assertEqual(set(patcher.cached_hook_patches[group]), {"0.weight", "1.weight"})
                    self.assertIsInstance(patcher.cached_hook_patches[group]["0.weight"][0], QuantizedTensor)
                else:
                    self.assertEqual(calculate_weight.call_count, first_apply_calls)
                patcher.patch_hooks(None)
                self.assertTrue(torch.equal(linear.weight._qdata, original_data))
                self.assertTrue(torch.equal(linear.weight._params.scale, original_scale))
                self.assertTrue(torch.equal(ordinary.weight, original_ordinary))

        del patcher
        gc.collect()

    def test_changed_upstream_setter_is_left_alone(self):
        original_get = model_patcher.get_key_weight
        original_patch_hooks = model_patcher.ModelPatcher.patch_hooks
        original_cached = model_patcher.ModelPatcher.patch_cached_hook_weights
        original_apply = model_patcher.ModelPatcher.patch_hook_weight_to_device
        original_unpatch = model_patcher.ModelPatcher.unpatch_hooks

        def restore_methods():
            model_patcher.get_key_weight = original_get
            model_patcher.ModelPatcher.patch_hooks = original_patch_hooks
            model_patcher.ModelPatcher.patch_cached_hook_weights = original_cached
            model_patcher.ModelPatcher.patch_hook_weight_to_device = original_apply
            model_patcher.ModelPatcher.unpatch_hooks = original_unpatch

        self.addCleanup(restore_methods)
        model_patcher.ModelPatcher.patch_hook_weight_to_device = _future_core_weight_hook
        self.assertFalse(quantized_hook_compat.install())
        self.assertIs(model_patcher.ModelPatcher.patch_hooks, original_patch_hooks)
        self.assertIs(model_patcher.ModelPatcher.patch_cached_hook_weights, original_cached)
        self.assertIs(model_patcher.ModelPatcher.patch_hook_weight_to_device, _future_core_weight_hook)
        self.assertIs(model_patcher.ModelPatcher.unpatch_hooks, original_unpatch)


if __name__ == "__main__":
    unittest.main()
