"""Document-owned output choices; capability checks never rewrite enabled flags."""
import re

MODES = ('prompt_control', 'moss')


def options(doc):
    meta = doc.root.meta
    if meta.get('output_mode', 'prompt_control') not in MODES:
        raise ValueError('Unknown PLV4 output mode')
    for key in ('sentence_case', 'moss_weights'):
        if key in meta and type(meta[key]) is not bool:
            raise ValueError(f'{key} must be boolean')
    return dict(output_mode=meta.get('output_mode', 'prompt_control'),
                sentence_case=meta.get('sentence_case', False),
                moss_weights=meta.get('moss_weights', False))


# MOSS block structure (user decisions 2026-10-20). The top level holds ordinary
# blocks, region blocks and the one [@moss] line; a region holds ordinary blocks.
# Only a block standing directly at one of those two levels picks its type
# (`.set{type: …}`); its subblocks inherit it. Anything else is not allowed: the
# UI never offers it, structural commands refuse it, hand-written ones grey out.
MOSS_FIELDS = {
    'root': ('caption', 'meta', 'palette'),
    'moss_region': ('caption', 'tag', 'palette', 'text'),
}
FIELD_LABELS = {'caption': 'Caption', 'meta': 'Meta', 'palette': 'Palette', 'tag': 'Tag', 'text': 'Text'}
PC_ONLY_FORMS = ('schedule', 'schedule_entry', 'region', 'region_entry', 'avg', 'avg_entry')


def _field(settings):
    if settings is None:
        return None
    return settings.get('type') if isinstance(settings, dict) else getattr(settings, 'moss_field', None)


def moss_rule(form, settings, parent, region_type=None):
    """Why a block may not stand where it is in MOSS mode, or None.

    `parent` is where it stands: 'root', 'moss_region', or 'block' (inside an
    ordinary block); `region_type` the type of the enclosing region block."""
    if form == 'paren':
        return None  # attention is item-level text, allowed wherever text is
    reason = moss_exclusion(form, settings)
    if reason:
        return reason
    if form in ('moss', 'moss_region'):
        if parent != 'root':
            return ('The [@moss] line' if form == 'moss' else 'A region block') + ' belongs at the top level'
        return None
    if form not in ('brace', 'implicit'):
        return 'This block is unavailable in MOSS mode'
    field = _field(settings)
    if field is None:
        return None
    if parent == 'block':
        return 'A subblock inherits its type from the block above it'
    if field not in MOSS_FIELDS[parent]:
        return f'{FIELD_LABELS[field]} is not available ' + ('at the top level' if parent == 'root' else 'in a region')
    if field == 'text' and region_type != 'text':
        return 'Text needs a region with type: text'
    return None


def moss_child_context(form, parent, region_type, moss_type=None):
    """(parent, region type) for the children of a block."""
    if form == 'moss_region':
        return 'moss_region', moss_type or 'object'
    if form == 'paren':
        return parent, region_type
    return 'block', region_type


def pc_rule(form, settings=None):
    if form == 'moss' or _field(settings) in ('meta', 'palette'):
        return 'MOSS only; not part of the Prompt Control output'
    return None


def moss_exclusion(form, settings):
    settings = settings or {}
    if not isinstance(settings, dict):
        settings = vars(settings)
    if form in ('schedule', 'schedule_entry', 'avg', 'avg_entry'):
        return 'Schedule / AVG is unavailable in MOSS mode'
    if form in ('region', 'region_entry'):
        return 'Region containers are unavailable in MOSS mode; convert them to region blocks'
    if settings.get('schedule') is not None or settings.get('region_window') is not None:
        return 'Timed blocks are unavailable in MOSS mode'
    region = settings.get('region')
    kind = region.get('kind') if isinstance(region, dict) else getattr(region, 'kind', None)
    if region is not None and form != 'moss_region':
        return 'Use a [@region] block for regions in MOSS mode'
    if kind in ('base', 'fill', 'imask'):
        return f'{kind.upper()} is unavailable in MOSS mode; use a rectangle MASK'
    fmt = settings.get('format') or ''
    if re.search(r'\b(?:CAT|AVG|AND|COUPLE)\b', fmt):
        return 'Conditioning operations are unavailable in MOSS mode'
    return None
