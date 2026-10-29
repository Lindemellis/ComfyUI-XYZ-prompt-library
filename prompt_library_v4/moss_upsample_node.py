"""Per-caption MOSS generation using the existing ComfyUI text encoder."""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import threading
import weakref

from .sentence_case import sentence_case

if '.' in __package__:
    from ..prompt_shared.image_metadata import check_prompt
else:
    from prompt_shared.image_metadata import check_prompt

SYSTEM = """Expand this image-region caption into a concise visual description in English.
Describe only this region's subject, appearance, action, materials and visual details.
Preserve every explicit fact, count, identity, color, relationship and exclusion.
Do not add other subjects, a new scene, borders, captions, titles or visible text.
Do not add camera or lighting details that contradict the requested scene.
Return only the caption in plain prose, with no JSON, coordinates or explanation."""


class PLV4MOSSUpsample:
    CATEGORY = 'XYZNodes/Prompt'
    FUNCTION = 'execute'
    RETURN_TYPES = ('STRING', 'STRING', 'PLV4_METADATA', 'STRING')
    RETURN_NAMES = ('prompt', 'plain', 'metadata', 'thinking')
    DESCRIPTION = ('TextGenerate with automatic MOSS Layout caption splitting and reassembly. '
        'Accepts a plain prompt or Layout JSON; optional PLV4 metadata selects captions and records the result for saving. '
        'Sampling controls apply only when sampling_mode is on. Image/video/audio require encoder support.')
    _cache = OrderedDict()
    _lock = threading.Lock()

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'clip': ('CLIP',),
            'enabled': ('BOOLEAN', {'default': True}),
            'seed': ('INT', {'default': 0, 'min': 0, 'max': 0xffffffffffffffff, 'control_after_generate': True}),
            'max_length': ('INT', {'default': 512, 'min': 1, 'max': 32768}),
            'temperature': ('FLOAT', {'default': 0.7, 'min': 0.01, 'max': 2.0, 'step': 0.000001}),
            'sampling_mode': (['on', 'off'], {'default': 'on'}),
            'top_k': ('INT', {'default': 64, 'min': 0, 'max': 1000}),
            'top_p': ('FLOAT', {'default': 0.95, 'min': 0.0, 'max': 1.0, 'step': 0.01}),
            'min_p': ('FLOAT', {'default': 0.05, 'min': 0.0, 'max': 1.0, 'step': 0.01}),
            'repetition_penalty': ('FLOAT', {'default': 1.05, 'min': 0.0, 'max': 5.0, 'step': 0.01}),
            'presence_penalty': ('FLOAT', {'default': 0.0, 'min': 0.0, 'max': 5.0, 'step': 0.01}),
            'thinking': ('BOOLEAN', {'default': False}),
            'use_default_template': ('BOOLEAN', {'default': True}),
            'mtp': (['auto', 'off', '2', '3', '4', '5'], {'default': 'auto'}),
            'system_prompt': ('STRING', {'multiline': True, 'default': SYSTEM}),
            # Dynamic prompt expansion would interpret Layout JSON braces as choices.
            'prompt': ('STRING', {'multiline': True, 'default': '', 'dynamicPrompts': False}),
        }, 'optional': {
            'metadata': ('PLV4_METADATA',),
            'image': ('IMAGE',), 'video': ('IMAGE',), 'audio': ('AUDIO',),
        }}

    @classmethod
    def _generate(cls, clip, caption, generation):
        from comfy_extras.nodes_textgen import TextGenerate
        # Native TextGenerate owns tokenization, decoding and reasoning extraction.
        output = TextGenerate.execute(clip=clip, prompt=caption, **generation)
        return output.args[0], output.args[1]

    @staticmethod
    def _layout(prompt):
        try:
            value = json.loads(prompt)
        except (ValueError, TypeError):
            return None
        if not isinstance(value, dict) or not isinstance(value.get('summary'), dict):
            return None  # ordinary TextGenerate input, including unrelated JSON
        value.setdefault('items', [])
        # A caption is left out when it would be empty, so it is optional here too.
        if (not isinstance(value['summary'].get('caption', ''), str)
            or not isinstance(value['items'], list)
            or any(not isinstance(i, dict) or not isinstance(i.get('caption', ''), str) for i in value['items'])):
            raise ValueError('Invalid MOSS Layout: summary and item captions must be strings.')
        return value

    def execute(self, metadata=None, clip=None, enabled=True, seed=0, max_length=512, temperature=0.7,
                prompt='', sampling_mode='on', top_k=64, top_p=0.95, min_p=0.05,
                repetition_penalty=1.05, presence_penalty=0.0, thinking=False,
                use_default_template=True, mtp='auto', system_prompt=SYSTEM,
                image=None, video=None, audio=None):
        result = None
        if metadata is not None:
            check_prompt(metadata)
            if metadata.get('output_mode') != 'moss':
                raise ValueError('Connect metadata from a PLV4 node in MOSS mode.')
            if prompt and prompt != metadata['prompt']:
                raise ValueError('MOSS prompt and metadata do not match; connect both from the same output.')
            result = deepcopy(metadata)
            prompt = result['prompt']
        controls = result['moss'] if result else {}
        original_plain = result['plain'] if result else prompt
        if not enabled: return prompt, original_plain, result, ''
        if result and not controls.get('summary_upsample') and not any(item['upsample'] for item in controls['items']):
            return prompt, original_plain, result, ''
        layout = self._layout(prompt)
        if result and len(controls['items']) != (len(layout['items']) if layout else 0):
            raise ValueError('MOSS metadata does not match the Layout.')
        if sampling_mode not in ('on', 'off'): raise ValueError('Invalid sampling_mode.')
        sampling = {'sampling_mode': sampling_mode}
        if sampling_mode == 'on':
            sampling.update(temperature=temperature, top_k=top_k, top_p=top_p, min_p=min_p,
                            repetition_penalty=repetition_penalty, presence_penalty=presence_penalty, seed=seed)
        generation = dict(max_length=max_length, sampling_mode=sampling, thinking=thinking,
                          use_default_template=use_default_template, mtp=mtp, system_prompt=system_prompt)
        settings_key = json.dumps(generation, sort_keys=True)
        generation.update(image=image, video=video, audio=audio)
        # Weight-patch identity and live encoder/tokenizer identity scope this cache.
        model_key = (str(getattr(clip.patcher, 'patches_uuid', '')), id(clip.patcher.model), id(clip.tokenizer))
        try:
            identities = (weakref.ref(clip.patcher.model), weakref.ref(clip.tokenizer))
        except TypeError:
            identities = None  # do not retain large encoders or cache by reusable object IDs alone
        if any(v is not None for v in (image, video, audio)):
            identities = None  # media may change in place; never cache it by object identity
        reasoning = {}
        def expand(caption, stable_id, requested):
            if not requested or not caption.strip(): return caption
            options = {**generation, 'sampling_mode': dict(sampling)}
            # Plain prompts and the summary use exactly the native seed. Stable region
            # IDs isolate a region's draw from edits or flags on other regions.
            if layout and stable_id != 'summary' and sampling_mode == 'on':
                options['sampling_mode']['seed'] = int.from_bytes(
                    hashlib.blake2b(f'{seed}:{stable_id}'.encode(), digest_size=8).digest(), 'big')
            key = (model_key, caption, stable_id, settings_key)
            with self._lock:
                cached = self._cache.get(key) if identities else None
                value = cached[2] if cached and cached[0]() is clip.patcher.model and cached[1]() is clip.tokenizer else None
                if value is not None: self._cache.move_to_end(key)
            if value is None:
                value = self._generate(clip, caption, options)
                if layout and (not value[0].strip() or value[0].lstrip().startswith(('```', '{', '['))):
                    raise ValueError('MOSS caption expansion failed; no valid plain caption was returned. Check max_length/thinking and system_prompt.')
                with self._lock:
                    if identities:
                        self._cache[key] = (*identities, value)
                        while len(self._cache) > 128: self._cache.popitem(last=False)
            if value[1]: reasoning[stable_id] = value[1]
            return sentence_case(value[0]) if controls.get('sentence_case') else value[0]
        if layout is not None:
            if 'caption' in layout['summary']:
                layout['summary']['caption'] = expand(layout['summary']['caption'], 'summary', controls.get('summary_upsample', True))
            selections = controls.get('items', [{'id':f'item:{i}', 'upsample':True} for i in range(len(layout['items']))])
            for item, control in zip(layout['items'], selections):
                if 'caption' in item:
                    item['caption'] = expand(item['caption'], control['id'], control['upsample'])
            if not layout['items']:
                del layout['items']  # a summary-only Layout stays summary-only
            prompt = json.dumps(layout, ensure_ascii=False, separators=(',', ':'))
            # Plain is an explicitly flattened view of the actual expanded descriptions.
            from .moss import _join, Part
            plain = _join([Part(text) for text in [layout['summary'].get('caption', ''), *[i.get('caption', '') for i in layout.get('items', [])]] if text])
        else:
            prompt = expand(prompt, 'summary', controls.get('summary_upsample', True))
            plain = prompt
        if result is not None:
            result.update(prompt=prompt, plain=plain)
            result['moss']['upsampler'] = json.loads(settings_key)
        thinking_output = json.dumps(reasoning, ensure_ascii=False) if layout is not None and reasoning else reasoning.get('summary', '')
        return prompt, plain, result, thinking_output
