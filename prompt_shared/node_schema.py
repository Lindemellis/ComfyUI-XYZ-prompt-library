"""Stable ComfyUI sockets/widgets shared by V3 compatibility and V4 nodes."""

NODE_USAGE = (
    "Compiles PLv3 text into comfyui-prompt-control syntax.\n"
    "Feed the output to 'PC: Schedule Prompt'; for LoRA scheduling, also feed "
    "the same output to 'PC: Schedule LoRAs' and use its model/clip outputs. "
    "'PCTextEncode' does not support schedule syntax.\n"
    "Regions are for the positive prompt only; don't put one in a negative prompt."
)


class PromptNodeSchema:
    """Only the schema: each node owns its execution and cache policy."""

    REGION_MODES: tuple[str, ...]  # supplied by the shared language/compiler
    CATEGORY = "XYZNodes/Prompt"
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "plain")
    OUTPUT_TOOLTIPS = (
        "The regions compiled to prompt-control (COUPLE / AND + MASK / IMASK / FILL).",
        "Every region flattened into ONE prompt, schedules and weights intact.",
    )
    DESCRIPTION = NODE_USAGE

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "tooltip": NODE_USAGE}),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random source for shuffle / random_select / dropout.",
                    },
                ),
                "region_mode": (
                    list(cls.REGION_MODES),
                    {
                        "default": "couple",
                        "tooltip": "couple = attention couple; mask = latent mask (AND + MASK).",
                    },
                ),
            },
            "optional": {
                # Hidden by the frontend; carries stable IDs and disabled items.
                # Keep the socket and widget order compatible with old workflows.
                "doc": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {"node_id": "UNIQUE_ID"},
        }
