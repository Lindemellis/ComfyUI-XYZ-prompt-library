"""LoRA block identity is metadata; its actual invocation remains PLv3 source."""
import math
import re
from .model import CommandError

REFERENCE = re.compile(r'^<lora:([^:<>]+):([-+\d.eE]+)(?::([-+\d.eE]+))?>$')


def invocation(node):
    if not isinstance(node.meta.get('lora'), dict) or not node.children: return None
    child = node.children[0]
    if not child.enabled: return None
    match = REFERENCE.fullmatch(child.raw.strip()) if child.kind == 'lora' else None
    if match and match[1] == node.meta['lora'].get('relative'):
        return child, match
    return None


def strengths(node):
    value = invocation(node)
    if not value: raise CommandError('invalid_lora', 'LoRA block 的调用项已移除，请从浏览器重新发送')
    match = value[1]
    return float(match[2]), float(match[3] or match[2])


def token(relative, model=1, clip=1):
    if not isinstance(relative, str) or not relative or any(char in relative for char in ':<>\r\n'):
        raise CommandError('invalid_lora', '无效 LoRA 文件名')
    for value in (model, clip):
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value): raise CommandError('invalid_lora', 'LoRA 权重必须是有限数值')
    return f'<lora:{relative}:{model:.12g}' + (f':{clip:.12g}' if clip != model else '') + '>'


def normalise(doc):
    for node in doc.root.walk(): node.meta.pop('lora_invocation', None)
    for node in doc.root.walk():
        if not node.meta.get('lora'): continue
        value = invocation(node)
        if value: value[0].meta['lora_invocation'] = True
        else: node.meta.pop('lora', None)
