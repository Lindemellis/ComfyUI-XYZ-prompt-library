"""CPU integration with installed Prompt Control; no model load or image sampling.

Run using ComfyUI's Python. A synthetic CLIP supplies known tiny tensors while
the real schedule parser, region processor and ConditioningAverage execute.
"""
from pathlib import Path
from types import SimpleNamespace
import sys
import re

ROOT = Path(__file__).resolve().parents[2]
COMFY = ROOT.parents[1]
sys.path[:0] = [str(ROOT), str(COMFY), str(ROOT.parent / 'comfyui-prompt-control')]
sys.argv = [sys.argv[0], '--cpu']

import torch
from prompt_control.parser import parse_prompt_schedules
from prompt_control.prompts import encode_prompt
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import EditorState


class Clip:
    def __init__(self):
        self.tokenizer = SimpleNamespace(clip_l=SimpleNamespace(pad_to_max_length=True))
        self.texts = ['']
        self.encoded = []

    def tokenize(self, text, return_word_ids=True):
        text = re.sub(r'[,\s]+$', '', text.strip())
        if text not in self.texts:
            self.texts.append(text)
        return {'l': [[(self.texts.index(text), 1, 1)]]}

    def encode_from_tokens_scheduled(self, tokens, add_dict):
        text = self.texts[tokens['l'][0][0][0]]
        self.encoded.append(text)
        value = {'a, b, d': 2, 'a, c, d': 10, 'a, e, d': 20}.get(text, 1)
        return [[torch.full((1, 2, 1), float(value)),
                 {**add_dict, 'pooled_output': torch.tensor([[float(value)]])}]]


def encode(source, mode='couple', step=.25):
    text = compile_document(EditorState.create(source), seed=42, region_mode=mode)['prompt']
    _, parsed = parse_prompt_schedules(text).at_step(step)
    clip = Clip()
    conditions = encode_prompt(clip, parsed['prompt'], 0, 1, {'mask_width': 8, 'mask_height': 8},
                               [torch.ones(1, 8, 8), torch.ones(1, 8, 8)])
    return conditions, parsed, clip


conditions, _, clip = encode('a, [@avg]: { 1: { b }, 3: { c } }, d')
assert len(conditions) == 1 and len(clip.encoded) == 2
assert torch.allclose(conditions[0][0], torch.full((1, 2, 1), 8.0))
assert conditions[0][1]['pooled_output'].item() == 8
conditions, _, clip = encode('a, [@avg]: { 1: { b }, 1: { c }, 1: { e } }, d')
assert len(conditions) == 1 and len(clip.encoded) == 3
assert torch.allclose(conditions[0][0], torch.full((1, 2, 1), 6 * .67 + 20 * .33))
source = 'a, <lora:ambient:0.8>, [@schedule]: { 0-0.5: { [@region]: { [base]: { sky }, [imask:0]: { [@avg]: { 1: { b, <lora:left:0.4> }, 3: { c, <lora:right:0.7> } } }, [fill]: { bg } } }, 0.5-1: { [@avg]: { 1: { b }, 1: { e } } } }, d'
for mode in ['couple', 'mask']:
    conditions, parsed, clip = encode(source, mode)
    assert parsed['loras'] == {'ambient': {'weight': .8, 'weight_clip': .8},
                               'left': {'weight': .4, 'weight_clip': .4},
                               'right': {'weight': .7, 'weight_clip': .7}}
    assert len(conditions) == (1 if mode == 'couple' else 3)
    assert 'a, b, d' in clip.encoded and 'a, c, d' in clip.encoded
    assert not any('AVG' in text or 'COUPLE' in text or 'AND' in text or '<lora:' in text for text in clip.encoded)
    conditions, parsed, clip = encode(source, mode, .75)
    assert parsed['loras'] == {'ambient': {'weight': .8, 'weight_clip': .8}}
    assert len(conditions) == 1 and set(clip.encoded) == {'a, b, d', 'a, e, d'}
    assert torch.allclose(conditions[0][0], torch.full((1, 2, 1), 11.0))
print('PASS actual Prompt Control: weighted tensors + pooled output, N-way AVG, scheduled regions, LoRA extraction, one averaged condition per region')
