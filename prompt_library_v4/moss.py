"""MOSS Layout adapter. Pure evaluation, no ambient injection or Library reads."""
from copy import deepcopy
from dataclasses import dataclass, field
import json
import math

from .model import CommandError, full_index, mode_reasons, pair_tree
from ._v3 import parse
from .output_policy import options
from .sentence_case import sentence_case

try:
    from ..prompt_shared.language.parser import Group, Item, Lora, Text
    from ..prompt_shared.language.ir import Part, RenderCtx, _randomise, _join
    from ..prompt_shared.language.diagnostics import Diagnostics
    from ..prompt_shared.language.lexer import unescape_bare
except ImportError:
    from prompt_shared.language.parser import Group, Item, Lora, Text
    from prompt_shared.language.ir import Part, RenderCtx, _randomise, _join
    from prompt_shared.language.diagnostics import Diagnostics
    from prompt_shared.language.lexer import unescape_bare


def dimensions(width, height, *, allow_missing=False):
    missing = [name for name, value in [('width', width), ('height', height)] if value is None]
    if missing and not allow_missing:
        raise CommandError('missing_dimensions', 'MOSS: connect ' + ' and '.join(missing) + ' to the generation resolution.')
    if any(type(v) is not int or v <= 0 or v > 16384 or v % 16 for v in (width, height) if v is not None):
        raise CommandError('invalid_dimensions', 'MOSS width / height must be positive multiples of 16, at most 16384.')
    return missing


def source_box(mask):
    if not mask or len(mask) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in mask):
        raise CommandError('invalid_moss_box', 'MOSS needs four finite rectangle coordinates.')
    x0, x1, y0, y1 = mask
    if not (0 <= x0 < x1 and 0 <= y0 < y1):
        raise CommandError('invalid_moss_box', 'MOSS rectangle must have positive area and non-negative source coordinates.')
    return x0, x1, y0, y1


def bbox(mask, width, height):
    x0, x1, y0, y1 = source_box(mask)
    # Existing PC rectangles may use pixels. All-fraction rectangles are resolution independent.
    if all(0 <= v <= 1 for v in mask):
        x0, x1, y0, y1 = x0 * width, x1 * width, y0 * height, y1 * height
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise CommandError('invalid_moss_box', 'MOSS rectangle must have positive area and stay inside the output canvas.')
    return [math.floor(round(y0, 9)) - height // 2, math.floor(round(x0, 9)) - width // 2,
            math.ceil(round(y1, 9)) - height // 2, math.ceil(round(x1, 9)) - width // 2]


@dataclass
class Content:
    text: str = ''  # caption text (or a leaf's text, typed by the block around it)
    items: list = field(default_factory=list)
    controls: list = field(default_factory=list)
    loras: list = field(default_factory=list)
    plain: str = ''
    tags: list = field(default_factory=list)
    palette: list = field(default_factory=list)
    texts: list = field(default_factory=list)
    meta: list = field(default_factory=list)

    def empty(self):
        return not (self.text or self.items or self.loras or self.tags or self.palette or self.texts or self.meta)


LIST_FIELDS = ('tag', 'palette', 'meta')


def unique(values):
    seen = set()
    return [v for v in values if v and not (v in seen or seen.add(v))]


def literal_text(source):
    """A text block's body as the words to draw: escapes resolved, the user's
    line breaks kept (a typed `\\n` is one too), layout indentation dropped."""
    text = unescape_bare(source).replace('\\n', '\n')
    lines = [line.strip() for line in text.split('\n')]
    while lines and not lines[0]: lines.pop(0)
    while lines and not lines[-1]: lines.pop()
    return '\n'.join(lines)


def plain_text(text):
    """Undo only the escapes the compiler adds for prompt-control.

    `\\:` / `\\#` (written bare by the user) and a doubled literal backslash go back
    to one character; a `\\(` the user typed in the Block stays exactly as typed.
    """
    out, i = [], 0
    while i < len(text):
        if text[i] == '\\' and i + 1 < len(text) and text[i + 1] in ':#\\':
            i += 1
        out.append(text[i]); i += 1
    return ''.join(out)


def json_literal(text):
    return text.replace('\\(', '(').replace('\\)', ')')


def compile_moss(state, seed, width, height, *, preview=False):
    config = options(state.doc)
    root, _ = parse(state.text)
    root = deepcopy(root)  # shared ASTs must remain read-only
    paired = {}; pair_tree(state.doc.root, root, paired, visible=True)
    docs = {id(paired[n.id]): n for n in state.doc.root.walk() if n.id in paired}
    _, complete = full_index(state.doc)
    reasons = mode_reasons(state.doc, complete)
    regional = state.doc.root.meta.get('region_enabled') is not False
    ctx = RenderCtx(seed=seed, diags=Diagnostics())
    diagnostics, settings = [], {}
    def join(values): return _join([Part(v) for v in values if v])
    def weighted(text, node):
        if config['moss_weights'] and text and node.settings.weight not in (None, 1):
            return f'({text}:{node.settings.weight:g})'
        return text
    def raw_text(node):
        """A text block's words as written: subblock shells dropped, contents kept."""
        a, b = node.spans.content
        out, at = [], a
        for child in node.children:
            if isinstance(child, Group) and not child.paren and child.spans.content:
                start, end = child.spans.node
                out += [state.text[at:start], raw_text(child).strip()]
                at = end
        out.append(state.text[at:b])
        return ''.join(out)
    def evaluate(node, field):
        """`field` is what this node fills (caption / meta / palette / tag / text),
        set by the top-level or region-level block above it. A leaf returns its
        string in `text`; the block around it decides what that string is."""
        if isinstance(node, Lora):
            return Content(loras=[(node.text, (0.0, 1.0))])
        if isinstance(node, Text):
            text = plain_text(node.text)
            return Content(text=text, plain=text)
        if isinstance(node, Item):
            chunks = [evaluate(c, field) for c in node.atoms]
            return Content(text=''.join(c.text for c in chunks).strip(),
                           plain=''.join(c.plain for c in chunks).strip(),
                           loras=[l for c in chunks for l in c.loras])
        if not isinstance(node, Group): return Content()
        doc = docs.get(id(node))
        if doc and doc.id in reasons:
            diagnostics.append(dict(id=doc.id, message=reasons[doc.id])); return Content()
        node.settings.seed = None  # V4 always uses the node seed
        form = doc.form if doc else ('paren' if node.paren else 'brace')
        if form == 'moss':
            settings.update(node.moss_config or {}); return Content()
        if form == 'moss_region':
            field = 'caption'  # each block in a region picks its own type
        elif form != 'paren':
            field = node.settings.moss_field or field
        if field == 'text' and form != 'paren':
            text = literal_text(raw_text(node))
            return Content(texts=[text] if text else [])
        children = [evaluate(c, field) for c in node.children]
        if form not in ('paren', 'moss_region') and field in LIST_FIELDS:
            # Every item of a tag / palette / meta block is one array entry.
            for child, content in zip(node.children, children):
                if not isinstance(child, Group) or child.paren:
                    setattr(content, 'tags' if field == 'tag' else field, [content.text] if content.text else [])
                    if field != 'tag': content.plain = ''
                    content.text = ''
        parts = [Part(c.text or 'x', origin=i) for i, c in enumerate(children) if not c.empty()]
        chosen = [children[p.origin] for p in _randomise(parts, node, ctx)]
        fmt = node.settings.format
        apply = (lambda value: fmt.replace('$p', value) if fmt and value else value)
        text = weighted(join([apply(c.text) for c in chosen]), node)
        plain = weighted(join([apply(c.plain) for c in chosen]), node)
        listed = lambda name: [weighted(apply(v), node) if field == 'tag' else apply(v) for c in chosen for v in getattr(c, name)]
        tags, palette, meta = listed('tags'), listed('palette'), listed('meta')
        texts = [t for c in chosen for t in c.texts]
        items = [item for c in chosen for item in c.items]
        controls = [item for c in chosen for item in c.controls]
        loras = [item for c in chosen for item in c.loras]
        if form == 'paren':
            return Content(text=text, plain=plain, loras=loras)
        if form == 'moss_region':
            label = node.moss_type or 'object'
            if not regional:
                # Region off: the region's description joins the summary.
                if texts:
                    diagnostics.append(dict(id=doc.id if doc else '', message='Region is off; visible text is left out'))
                return Content(text=join([text, *unique(tags)]), plain=plain, palette=palette, loras=loras)
            item = dict(label=label)
            if text: item['caption'] = text
            if label == 'text' and texts: item['text'] = '\n'.join(texts)
            if tags: item['tags'] = unique(tags)
            if palette: item['palette'] = unique(palette)
            if len(item) > 1:
                # Carry source coordinates through random selection first. Only
                # rectangles that actually survive into the output need a canvas.
                item['bbox'] = deepcopy(node.settings.region.mask)
                items.append(item)
                controls.append(dict(id=doc.id if doc else str(node.path),
                                     upsample=bool((doc.meta.get('moss', {}) if doc else {}).get('upsample', False))))
            return Content(items=items, controls=controls, loras=loras, plain=plain)
        return Content(text=text, plain=plain, tags=tags, palette=palette, meta=meta, texts=texts,
                       items=items, controls=controls, loras=loras)
    result = evaluate(root, 'caption')
    missing = dimensions(width, height, allow_missing=preview or not result.items)
    provisional = bool(missing and result.items)
    for item in result.items:
        mask = item['bbox']
        if provisional:
            x0, x1, y0, y1 = source_box(mask)
            item['bbox'] = [y0, x0, y1, x1]
            item['bbox_units'] = 'normalized' if all(0 <= v <= 1 for v in mask) else 'abs'
        else:
            item['bbox'] = bbox(mask, width, height)
    if config['sentence_case']:
        result.text = sentence_case(result.text); result.plain = sentence_case(result.plain)
        for item in result.items:
            if 'caption' in item: item['caption'] = sentence_case(item['caption'])
    # Decide from selected items only: random/excluded regions do not affect preview units.
    spaces = {item['bbox_units'] for item in result.items} if provisional else set()
    space = next(iter(spaces)) if len(spaces) == 1 else 'source_preview'
    if len(spaces) == 1:
        for item in result.items: item.pop('bbox_units')
    # The encoder reads the JSON source, where `\(` is serialised as `\\(` and
    # ComfyUI's escape pass would leave one backslash for the model. Weights are
    # off for MOSS, so a bare paren is already literal: write it bare.
    literal = lambda value: [json_literal(v) for v in value] if isinstance(value, list) else json_literal(value)
    summary = {}
    if result.meta: summary['meta'] = literal(unique(result.meta))
    if settings.get('canvas'): summary['canvas'] = settings['canvas']
    if result.text: summary['caption'] = literal(result.text)
    if result.palette: summary['palette'] = literal(unique(result.palette))
    for item in result.items:
        for key in ('caption', 'text', 'tags', 'palette'):
            if key in item: item[key] = literal(item[key])
    layout = dict(summary=summary)
    if result.items:
        layout.update(items=result.items, bbox_coord_space=space if provisional else 'abs_centralized',
                      bbox_format='yxyx')
    # Nothing but a caption (a negative prompt, say): plain text, escapes as typed.
    plain_only = not result.items and set(summary) <= {'caption'}
    prompt = result.text if plain_only else json.dumps(layout, ensure_ascii=False, separators=(',', ':'))
    return dict(prompt=prompt, plain=result.plain, loras=result.loras, diagnostics=diagnostics,
                preview_only=provisional,
                preview_notice=('MOSS 预览：宽高尚未解析，bbox 暂用 0–1 比例坐标（yxyx）；运行时按实际宽高换算。'
                    if not spaces or spaces == {'normalized'} else
                    'MOSS 预览：宽高尚未解析，bbox 保留原始坐标（yxyx）；旧像素矩形将在运行时换算、校验。') if provisional else '',
                moss=dict(width=width, height=height, items=result.controls,
                          summary_upsample=bool(state.doc.root.meta.get('moss', {}).get('upsample', False)),
                          sentence_case=config['sentence_case']))
