"""Explicit positive/negative snapshots, ready for Aaalice Conditional Save Image."""
from copy import deepcopy

from ._v3 import compile_text, parse

if '.' in __package__:
    from ..prompt_shared.image_metadata import (IMAGE_SCHEMA, check_prompt,
        encode_parameters, lora_records, merge_loras, selected_text)
    from ..prompt_shared.language.parser import Group, Item, Lora, Text
else:
    from prompt_shared.image_metadata import (IMAGE_SCHEMA, check_prompt,
        encode_parameters, lora_records, merge_loras, selected_text)
    from prompt_shared.language.parser import Group, Item, Lora, Text


def extra_loras(source):
    root, _ = parse(source)
    def check(node):
        if isinstance(node, Lora):
            if not node.text.startswith('<lora:'):
                raise ValueError('Additional syntax accepts LoRA calls only')
        elif isinstance(node, Text):
            if node.text.strip():
                raise ValueError('Additional syntax accepts LoRA calls only')
        elif isinstance(node, Item):
            for atom in node.atoms:
                check(atom)
        elif isinstance(node, Group):
            settings = node.settings
            if node.average or any((settings.shuffle, settings.random_select is not None,
                settings.dropout, settings.seed is not None, settings.region is not None,
                settings.weight is not None, settings.format is not None)):
                raise ValueError('Additional LoRA syntax accepts fixed calls and schedules, without random settings')
            for child in node.children:
                check(child)
        else:
            raise ValueError('Invalid additional LoRA syntax')
    check(root)
    return lora_records(compile_text(source, centralize_loras=True).loras)


class PLV4ImageMetadataNode:
    CATEGORY = 'XYZNodes/Prompt'
    FUNCTION = 'execute'
    RETURN_TYPES = ('METADATA',)
    RETURN_NAMES = ('metadata',)
    DESCRIPTION = ('Merge PLV4 positive/negative snapshots and additional LoRA syntax. '
        'Connect to Aaalice Conditional Save Image; Lora Manager must be installed. '
        'Output selectors must match the prompt/plain sockets used by your encoders.')

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'positive_metadata': ('PLV4_METADATA',),
            'positive_output': (['prompt', 'plain'], {'default': 'prompt'}),
            'negative_output': (['prompt', 'plain'], {'default': 'prompt'}),
            'lora_syntax': ('STRING', {'default': '', 'multiline': True,
                'tooltip': 'Additional fixed LoRA calls, optionally scheduled. Negative LoRAs are excluded.'}),
        }, 'optional': {'negative_metadata': ('PLV4_METADATA',)}}

    def execute(self, positive_metadata, positive_output='prompt', negative_output='prompt',
                lora_syntax='', negative_metadata=None):
        def snapshot(value, output):
            check_prompt(value)
            if output not in ('prompt', 'plain'):
                raise ValueError('Select prompt or plain to match the encoder input')
            result = deepcopy(value)
            result.pop('prompt_loras', None)
            result.pop('plain_loras', None)
            result['selected_output'] = output
            return result
        positive = snapshot(positive_metadata, positive_output)
        negative = snapshot(negative_metadata, negative_output) if negative_metadata is not None else None
        loras = merge_loras(positive_metadata[positive_output + '_loras'], extra_loras(lora_syntax))
        result = dict(schema=IMAGE_SCHEMA, version=1, positive=positive, negative=negative,
                      extra_lora_syntax=lora_syntax, loras=loras)
        # Lora Manager's legacy formatter supports one strength for hash lookup.
        # Exact dual strengths and schedules remain in the structured snapshot.
        compatibility = ' '.join(f"<lora:{row['name']}:{row['model_strength']:.12g}>"
                                 for row in loras if 'name' in row)
        result['overrides'] = dict(prompt=selected_text(positive), negative_prompt=selected_text(negative),
                                  loras=compatibility, additional_data=encode_parameters(result))
        return (result,)
