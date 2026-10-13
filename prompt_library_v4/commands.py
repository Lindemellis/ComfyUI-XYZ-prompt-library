"""Atomic, revision-checked edits over the shared PLv3 Document.

Commands address IDs and adjacent IDs, never an array index from an old view.
Prompt Library insertions consume expanded snapshots; pool transactions belong
to its asset service. Mask binding commands use the V4-only resource adapter,
then the existing Region editing commands; the shared language remains pure.
"""
from __future__ import annotations

from copy import deepcopy
import json
import math
import re

from ._v3 import DocNode, Document, from_text, render, ast_json
from .model import (CommandError, EditorState, full_document, full_index,
                    projection, python_offset, refresh_document, text_edit)
from .formatting import format_document, format_new_block

_LAYOUT_COMMANDS = {"WrapSelection", "MoveBlock", "InsertBlock", "InsertEntry", "InsertLibraryBlock",
                    "InsertLibraryPrompts", "MergeLibraryBlock", "EnableCandidate", "CompleteLibrary",
                    "UpdateLibraryBlock", "SetSettings", "SetPromptSettings",
                    "SetRegion", "SetScheduleBoundary", "Delete"}
_LOCAL_INSERT_COMMANDS = {"WrapSelection", "InsertBlock", "InsertEntry", "InsertLibraryBlock", "InsertLibraryPrompts", "MergeLibraryBlock", "EnableCandidate", "SetPromptSettings", "InsertLora"}


def _new_container(form):
    if form == "schedule":
        node = _fragment("[@schedule]: { 0 - 0.5: { }, 0.5 - 1: { } }")
        names = ["阶段 1", "阶段 2"]
    elif form == "region":
        node = _fragment("[@region]: { [base]: { } [mask: [0, 0.5, 0, 1]]: { } "
                         "[mask: [0.5, 1, 0, 1]]: { } [fill]: { } }")
        names = ["Base", "Mask 1", "Mask 2", "Fill"]
    elif form == 'avg':
        node = _fragment('[@avg]: { 1: { }, 1: { } }')
        names = ['Entry 1', 'Entry 2']
    else:
        raise CommandError("invalid_container", "请选择 Schedule、Region 或 AVG 容器")
    for entry, name in zip(node.children, names):
        entry.meta["name"] = name
    return node


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CommandError("invalid_setting", "expected a finite number")
    return format(value, ".12g")


def _interval(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise CommandError("invalid_setting", "expected [start, end]")
    a, b = value
    _number(a), _number(b)
    if not 0 <= a <= b <= 1:
        raise CommandError("invalid_setting", "interval must satisfy 0 <= start <= end <= 1")
    return a, b


def region_head(value):
    if not isinstance(value, dict) or value.get("kind") not in ("base", "fill", "mask", "imask"):
        raise CommandError("invalid_setting", "region needs base, fill, mask or imask kind")
    kind = value["kind"]
    if kind == "mask":
        mask = value.get("mask")
        if not isinstance(mask, (list, tuple)) or len(mask) != 4:
            raise CommandError("invalid_setting", "mask needs four coordinates")
        first = "mask: [" + ", ".join(_number(n) for n in mask) + "]"
    elif kind == "imask":
        index = value.get("imask")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise CommandError("invalid_setting", "IMASK attach order must be a non-negative integer")
        first = f"imask: {index}"
    else:
        first = kind
    parts = [first]
    for key, item in value.items():
        if key in ("kind", "mask", "imask") or item is None:
            continue
        if key == "include_in_base":
            if not isinstance(item, bool):
                raise CommandError("invalid_setting", "include_in_base must be boolean")
            parts.append(f"{key}: {str(item).lower()}")
        elif key in ("feather", "mask_weight", "cond_weight"):
            parts.append(f"{key}: {_number(item)}")
        else:
            raise CommandError("invalid_setting", f"unknown region setting: {key}")
    return "[" + ", ".join(parts) + "]"


def setting_value(key, value):
    if key == "seed":
        raise CommandError("node_seed_only", "PLv4 randomness uses the ComfyUI node seed input")
    if key == "format":
        if not isinstance(value, str):
            raise CommandError("invalid_setting", "format must be a string")
        return json.dumps(value, ensure_ascii=False)
    if key == "shuffle":
        if not isinstance(value, bool):
            raise CommandError("invalid_setting", "shuffle must be boolean")
        return str(value).lower()
    if key == "random_select":
        values = [value, value] if isinstance(value, int) else value
        if not isinstance(values, (list, tuple)) or len(values) != 2 or any(
                isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in values):
            raise CommandError("invalid_setting", "random_select needs non-negative integers")
        a, b = values
        if a > b:
            raise CommandError("invalid_setting", "random_select minimum exceeds maximum")
        return str(a) if a == b else f"{a}-{b}"
    if key in ("schedule", "region_window"):
        return "{" + ", ".join(_number(n) for n in _interval(value)) + "}"
    if key == "region":
        return region_head(value)
    if key in ("weight", "dropout"):
        result = _number(value)
        if value < 0 or (key == "dropout" and value > 1):
            raise CommandError("invalid_setting", f"{key} is outside its range")
        return result
    raise CommandError("invalid_setting", f"unknown setting: {key}")


def _parents(doc):
    return {c.id: p for p in doc.root.walk() for c in p.children}


def _node(doc, node_id):
    node = doc.find(node_id)
    if node is None:
        raise CommandError("unknown_node", f"unknown document ID: {node_id}")
    return node


def _new_id(doc):
    node_id = f"i{doc.next_id}"
    doc.next_id += 1
    return node_id


def _clone_ids(doc, node):
    clone = deepcopy(node)
    source_ids = {part.id for part in node.walk()}
    for part in clone.walk():
        part.id = _new_id(doc)
        while part.id in source_ids:
            part.id = _new_id(doc)
    return clone


def _body(node):
    return render(full_document(Document(deepcopy(node))))


def _fragment(source, form=None):
    prefix = {'schedule_entry': '[@schedule]: { ', 'region_entry': '[@region]: { ', 'avg_entry': '[@avg]: { '}.get(form, '')
    parsed = from_text(prefix + source + (" }" if prefix else ""), recover=False)
    nodes = parsed.root.children[0].children if prefix else parsed.root.children
    if len(nodes) != 1:
        raise CommandError("single_item", "replacement must contain exactly one complete item")
    return nodes[0]


def _replace_shell(node, parsed):
    # Settings/head edits cannot change content structure or identity.
    def transfer(old, fresh):
        if old.kind != fresh.kind or len(old.children) != len(fresh.children):
            raise CommandError("shape_mismatch", "setting edit changed the item's structure")
        fresh.id, fresh.enabled, fresh.meta = old.id, old.enabled, deepcopy(old.meta)
        for a, b in zip(old.children, fresh.children):
            transfer(a, b)
    transfer(node, parsed)
    parsed.sep = node.sep
    node.__dict__.update(parsed.__dict__)


def _local_edits(doc, node, edits):
    _, index = full_index(doc)
    ast = index[node.id]
    source = _body(node)
    start = ast.end - len(source)  # includes region/schedule heads outside spans.node
    for (a, b), insert in sorted(edits, reverse=True):
        source = source[:a-start] + insert + source[b-start:]
    _replace_shell(node, _fragment(source, node.form))


def _explicit(node):
    if node.kind != "group":
        raise CommandError("invalid_parent", "destination is not a block")
    if node.opaque:
        raise CommandError("opaque_block", "this block cannot be structurally edited")
    # A bare special entry needs real braces once its body has structural edits.
    if node.form == "implicit" or (node.form in ("schedule_entry", "region_entry", 'avg_entry') and not node.close):
        node.open = node.open.rstrip() + " {"
        if not node.children and not node.lead:
            node.lead = " "
        node.close = " }"


def _ordinary_parent(node):
    _explicit(node)
    if node.form in ("schedule", "region", 'avg', "paren"):
        raise CommandError("special_boundary", "special containers require an entry command")


def _position(parent, command):
    before, after = command.get("before_id"), command.get("after_id")
    if before is not None and after is not None:
        raise CommandError("invalid_boundary", "use one adjacent ID, not both")
    if before is not None:
        for index, node in enumerate(parent.children):
            if node.id == before:
                return index
        raise CommandError("invalid_boundary", "before_id is not a child of the destination")
    if after is not None:
        for index, node in enumerate(parent.children):
            if node.id == after:
                return index + 1
        raise CommandError("invalid_boundary", "after_id is not a child of the destination")
    edge = command.get("edge", "end")
    if edge not in ("start", "end"):
        raise CommandError("invalid_boundary", "edge must be start or end")
    return 0 if edge == "start" else len(parent.children)


def _separate(node):
    # Separators belong to the item being moved, and period-ended items need blank.
    if not node.sep or not node.sep.strip():
        node.sep = ("" if _body(node).rstrip().endswith(".") else ",") + (node.sep or " ")


def _selected(doc, ids):
    if not ids or len(ids) != len(set(ids)):
        raise CommandError("invalid_selection", "select distinct complete items")
    parents = _parents(doc)
    first = _node(doc, ids[0])
    parent = parents.get(first.id)
    if parent is None or any(parents.get(i) is not parent for i in ids):
        raise CommandError("cross_parent", "selection must have a single parent")
    positions = [next(i for i, n in enumerate(parent.children) if n.id == node_id) for node_id in ids]
    if positions != sorted(positions):
        raise CommandError("invalid_selection", "selection must follow document order")
    a, b = positions[0], positions[-1]
    if any(node.meta.get('lora_invocation') for node in parent.children[a:b+1]):
        raise CommandError('fixed_lora', 'LoRA 调用项不能作为正文分组或编辑')
    # Invisible disabled siblings strictly between the endpoints move into the group.
    if any(n.enabled and n.id not in ids for n in parent.children[a:b+1]):
        raise CommandError("non_contiguous", "selection must include every visible item between endpoints")
    return parent, a, b


def selection_ids(state, span):
    a, b = [python_offset(state.text, n) for n in span]
    if a >= b:
        raise CommandError("invalid_selection", "select a non-empty range")
    tree = projection(state)["tree"]
    candidates = []

    def scan(node, depth=0):
        children = [c for c in node["children"] if c["span"]]
        touched = [c for c in children if python_offset(state.text, c["span"][0]) < b
                   and python_offset(state.text, c["span"][1]) > a]
        if touched:
            start = python_offset(state.text, touched[0]["span"][0])
            end = python_offset(state.text, touched[-1]["span"][1])
            outside = state.text[a:start] if a < start else ""
            outside += state.text[end:b] if b > end else ""
            if not outside.strip(" ,\t\r\n"):
                complete = all(c["kind"] != "group" or c["form"] == "paren" or (
                    a <= python_offset(state.text, c["span"][0]) and
                    b >= python_offset(state.text, c["span"][1])) for c in touched)
                if complete:
                    candidates.append((depth, [c["id"] for c in touched]))
        for child in node["children"]:
            if child["kind"] == "group" and child["form"] != "paren":
                scan(child, depth + 1)
    scan(tree)
    if not candidates:
        raise CommandError("invalid_selection", "selection crosses a block or special header")
    return max(candidates, key=lambda pair: pair[0])[1]


def _set_settings(doc, node, values):
    if node.kind != "group":
        raise CommandError("invalid_setting", "item settings need a block or attention group")
    for key, value in values.items():
        if key == "seed":
            raise CommandError("node_seed_only", "use the ComfyUI node seed input")
        if node.form in ('schedule', 'region', 'avg', 'avg_entry') and key in ('shuffle', 'dropout', 'random_select', 'format') and value is not None:
            raise CommandError('container_setting', '请在正文 subblock 中设置格式与随机选项')
        _, index = full_index(doc)
        ast = index[node.id]
        spans = ast.spans
        if (key == "region" and spans.region_form == "block") or (
                key == "schedule" and spans.schedule_form == "block"):
            raise CommandError("special_setting", "edit the special entry head or shared boundary")
        if (node.form == "schedule" and key == "schedule") or (node.form == "region" and key == "region"):
            raise CommandError("special_setting", "this setting is owned by the special container")
        if key == "region_window" and node.form != "region":
            raise CommandError("special_setting", "region_window belongs to a Region container")
        if node.form == "paren" and key != "weight":
            raise CommandError("attention_setting", "attention syntax only carries weight")
        if node.form == "paren":
            if value is None:
                value = 1
            value_text = setting_value(key, value)
            # Paren weight is inside close, not a .set field.
            import re
            node.close = re.sub(r":\s*[-+\d.eE]+\s*(?=\))", ":" + value_text, node.close)
            if ":" not in node.close:
                node.close = ":" + value_text + node.close
            continue
        field = spans.fields.get(key)
        if value is None:
            if field:
                _local_edits(doc, node, [(field["entry"], "")])
            continue
        literal = setting_value(key, value)
        if field:
            _local_edits(doc, node, [(field["value"], literal)])
        elif spans.set_body:
            source, _ = full_index(doc)
            a, b = spans.set_body
            old = source[a:b]
            join = " " if old.rstrip().endswith(",") or not old.strip() else ", "
            _local_edits(doc, node, [((b, b), join + key + ": " + literal)])
        else:
            node.close += ".set{" + key + ": " + literal + "}"


def _schedule_head(doc, node, interval):
    a, b = _interval(interval)
    _, index = full_index(doc)
    span = index[node.id].spans.fields["schedule"]["value"]
    _local_edits(doc, node, [(span, f"{_number(a)} - {_number(b)}")])


def _normalise_schedule(doc, parent):
    if parent.form != "schedule":
        return
    # Include parked entries so enabling one restores its stored timeline slot.
    _, index = full_index(doc)
    intervals = [index[n.id].settings.schedule for n in parent.children]
    starts = [v[0] for v in intervals]
    if starts != sorted(starts):
        raise CommandError("schedule_order", "schedule entries must follow increasing start times")
    for prev, following in zip(parent.children, parent.children[1:]):
        _, current = full_index(doc)
        old = current[prev.id].settings.schedule
        _schedule_head(doc, prev, (old[0], current[following.id].settings.schedule[0]))


def _attach_entry(doc, parent, node, entry):
    if parent.form not in ("schedule", "region", 'avg'):
        _ordinary_parent(parent)
        return
    if not isinstance(entry, dict):
        raise CommandError("special_boundary", "drop into a special container needs explicit entry settings")
    if parent.form == 'avg':
        if 'avg_weight' not in entry:
            raise CommandError('special_boundary', 'AVG 容器需要 AVG entry 权重')
        value = entry['avg_weight']
        _number(value)
        if value < 0:
            raise CommandError('invalid_setting', 'AVG 权重必须非负')
        node.open = _number(value) + ': ' + node.open
        node.form = 'avg_entry'
        return
    _explicit(node)
    if node.form in ("schedule", "region", "paren"):
        raise CommandError("special_boundary", "drop a regular body block into a special entry")
    if node.header:
        raise CommandError("special_boundary", "insert a Library block inside an entry body to preserve its header")
    kind = parent.form
    if kind not in entry:
        raise CommandError("special_boundary", f"destination requires {kind} entry settings")
    # Remove an equivalent set setting before making it a block head.
    _set_settings(doc, node, {kind: None})
    head = (f"{_number(_interval(entry[kind])[0])} - {_number(_interval(entry[kind])[1])}"
            if kind == "schedule" else region_head(entry[kind]))
    node.open = head + ": " + node.open
    node.form = kind + "_entry"


def _locate(state, node_id):
    node = _node(state.doc, node_id)
    target = node
    parents = _parents(state.doc)
    complete = None
    while target is not state.doc.root:
        prompt = target.meta.get("presentation") == "prompt"
        if prompt and target.form != "paren":
            if complete is None:
                _, complete = full_index(state.doc)
            settings = complete[target.id].settings
            prompt = (target.form == "brace" and len(target.children) == 1 and target.children[0].enabled
                      and (target.children[0].kind != 'group' or target.children[0].form == 'paren')
                      and settings.region is None and not settings.format and not settings.shuffle
                      and not settings.random_select and not settings.dropout and settings.seed is None)
        if target.kind == "group" and target.form != "paren" and not prompt:
            break
        target = parents[target.id]
    state.selection = dict(node_id=node.id, block_id=target.id,
                           prompt_id=None if target is node else node.id)


def _prompt_settings(doc, node, patch):
    if not patch or any(k not in ("weight", "schedule", "region") for k in patch):
        raise CommandError("invalid_setting", "prompt settings are weight, schedule and region")
    parent = _parents(doc).get(node.id)
    if parent is None:
        raise CommandError("invalid_setting", "select a prompt item")
    # Existing one-item setting wrappers remain the same instance on later edits.
    target = parent if parent.meta.get("presentation") == "prompt" or (parent.form == "paren" and len(parent.children) == 1) else node
    values = dict(patch)
    if node.kind == "lora" and "weight" in values:
        value = values.pop("weight")
        literal = _number(1 if value is None else value)
        opening, _, suffix = node.raw.rpartition(":")
        if not opening or ">" not in suffix:
            raise CommandError("invalid_setting", "cannot locate LoRA weight")
        node.raw = opening + ":" + literal + suffix[suffix.index(">"):]
    if not values:
        return
    # Unit attention is the unweighted prompt. LoRA's explicit strength above
    # remains part of its invocation syntax, rather than an attention wrapper.
    if "weight" in values and values["weight"] is not None:
        _number(values["weight"])
        if values["weight"] == 1:
            values["weight"] = None
    if target.kind == "group" and target.form == "paren" and set(values) <= {"weight"}:
        if values["weight"] is None:
            owner = _parents(doc)[target.id]
            position = owner.children.index(target)
            if position:
                owner.children[position - 1].sep += target.lead
            else:
                owner.lead += target.lead
            for child in target.children:
                child.enabled = child.enabled and target.enabled
            target.children[-1].sep += target.sep
            owner.children[position:position + 1] = target.children
            return
        _set_settings(doc, target, values)
        return target
    if target.kind == "group" and target.form == "paren":
        # Attention shorthand cannot hold a schedule/region. Promote the editor's
        # one-item shell, retaining its weight and all instance IDs.
        _, index = full_index(doc)
        weight = index[target.id].settings.weight
        target.open, target.close, target.form = "{ ", " }", "brace"
        target.meta["presentation"] = "prompt"
        _set_settings(doc, target, {"weight": weight, **values})
        return target
    if target.kind == "group" and target.meta.get("presentation") == "prompt":
        _set_settings(doc, target, values)
        return target
    if node.kind == "group" and node.form != "paren":
        raise CommandError("invalid_setting", "use block settings for this group")
    if set(values) == {"weight"} and values["weight"] is None:
        return
    wrapper = DocNode(_new_id(doc), "group", "", sep=node.sep, opaque=False,
                      children=[node], meta={"presentation": "prompt"})
    node.sep = ""
    if set(values) == {"weight"}:
        value = values["weight"]
        wrapper.open, wrapper.close, wrapper.form = "(", ":" + setting_value("weight", 1 if value is None else value) + ")", "paren"
    else:
        wrapper.open, wrapper.close, wrapper.form = "{ ", " }", "brace"
    parent.children[parent.children.index(node)] = wrapper
    if wrapper.form == "brace":
        _set_settings(doc, wrapper, values)
    return wrapper


def _flatten(node):
    if not node.enabled:
        return []
    # Attention (including multi-item attention) is an item-level weight wrapper.
    if node.kind != "group" or node.form == "paren":
        return [DocNode("", node.kind, render(node), sep=", ")]
    return [part for child in node.children for part in _flatten(child)]


def _pool_block(node):
    if node.kind != 'group' or node.form == 'paren': return False
    return not (node.meta.get('presentation') == 'prompt' and node.form == 'brace' and len(node.children) == 1
                and node.children[0].enabled and (node.children[0].kind != 'group' or node.children[0].form == 'paren'))


def _pool_key(node):
    while node.kind == 'group' and len(node.children) == 1 and (node.form == 'paren' or node.meta.get('presentation') == 'prompt'):
        node = node.children[0]
    text = _body(node).strip()
    if node.kind == 'lora': return re.sub(r':([-+\d.eE]+)>$', '>', text)
    return re.sub(r'\s+', ' ', text.replace('_', ' '))


def _merge_pool_block(doc, parent, source, command):
    if not parent.meta.get('pool') or source.meta.get('pool') != parent.meta['pool'] or source.meta.get('lora'):
        raise CommandError('invalid_pool', '只能合并属于同一个 Class 的普通 Block')
    if source.form != 'brace' or source.opaque:
        raise CommandError('invalid_asset', '合并需要完整普通 Block')
    prompts, blocks = set(), []
    def scan(node):
        if node is not parent:
            if not _pool_block(node): prompts.add(_pool_key(node)); return
            blocks.append(node)
            if node.meta.get('pool'): return
        for child in node.children: scan(child)
    scan(parent)
    def trim(node):
        if _pool_block(node):
            # Independent pools and special containers keep their own semantics.
            if node.meta.get('pool') or node.meta.get('lora') or node.form != 'brace': return node
            node.children = [part for child in node.children if (part := trim(child)) is not None]
            return node
        key = _pool_key(node)
        if key in prompts: return None
        prompts.add(key)
        return node
    position = _position(parent, command)
    for child in source.children:
        occurrence = [*command['occurrence'], child.id]
        if _pool_block(child):
            source_id = child.meta.get('source', {}).get('id')
            if any(existing.meta.get('occurrence') == occurrence or (source_id and existing.meta.get('source', {}).get('id') == source_id) for existing in blocks): continue
        elif _pool_key(child) in prompts: continue
        part = trim(_clone_ids(doc, child))
        if part is None: continue
        part.meta['occurrence'] = occurrence
        _separate(part)
        parent.children.insert(position, part); position += 1
        if _pool_block(part): format_new_block(doc, part)
        scan(part)


def apply_command(state: EditorState, command: dict) -> EditorState:
    """Return a new state, or reject atomically. Never mutate the caller's snapshot."""
    if isinstance(command.get("revision"), bool) or not isinstance(command.get("revision"), int) or command.get("revision") != state.revision:
        raise CommandError("stale_revision", "document changed; recompute the target against its new revision")
    result = deepcopy(state)
    kind = command.get("type")
    if kind in ('BindMaskLibrary', 'UnbindMaskLibrary'):
        from .mask_resources import binding_command
        result = binding_command(result, command)
        result.revision = state.revision + 1
        result.check()
        return result
    if kind == 'ExpandLibraryReference':
        a, b = (python_offset(result.text, offset) for offset in command['span'])
        if result.text[a:b] != '[' + command['path'] + ']':
            raise CommandError('stale_reference', 'Library 路径或光标已变化，请重新选择')
        snapshot = DocNode.from_json(command['snapshot'])
        snapshot.enabled = True
        inserted = render(snapshot)
        result.replace_text(result.text[:a] + inserted + result.text[b:]); result.check()
        tree = projection(result)['tree']
        start = command['span'][0]
        def locate(value):
            if value['form'] != 'root' and value['span'] and value['span'][0] == start: return value['id']
            return next((found for child in value['children'] if (found := locate(child))), None)
        node = _node(result.doc, locate(tree)); parent = _parents(result.doc)[node.id]
        part = _clone_ids(result.doc, snapshot); part.id = node.id; part.sep = node.sep
        part.meta['source'] = deepcopy(command['source']); parent.children[parent.children.index(node)] = part
        _locate(result, part.id); result.doc = format_document(refresh_document(format_document(result.doc))); result.check()
    elif kind == "CreateAsBlock":
        result.check()
        span = command.get('span')
        if not isinstance(span, list) or len(span) != 2:
            raise CommandError('invalid_span', 'select prompt text to create a block')
        a, b = [python_offset(result.text, at) for at in span]
        if a >= b:
            raise CommandError('invalid_selection', 'select a non-empty string')
        import re
        before, body, after = result.text[:a], result.text[a:b], result.text[b:]
        indent = re.match(r'[ \t]*', before.rsplit('\n', 1)[-1]).group()
        block = '{\n' + indent + '    ' + body + '\n' + indent + '}'
        result.replace_text(before + block + after)
        if not result.valid:
            raise CommandError('invalid_selection', '选择 prompt 内容，避免截断权重、LoRA 或 Schedule 语法')
        def locate(row):
            if row['kind'] == 'group' and row['form'] == 'brace' and row['span'] and row['span'][0] == span[0]:
                return row['id']
            return next((found for child in row['children'] if (found := locate(child))), None)
        block_id = locate(projection(result)['tree'])
        if not block_id:
            raise CommandError('invalid_selection', '无法把这段文字转换为 block')
        _locate(result, block_id)
    elif kind == "ReplaceText":
        result.replace_text(command["text"])
        # Native text runs are anchored between actual document children,
        # including parked blocks with no source offsets. Move the complete
        # edited run back into that gap; new text must not push existing run
        # items across a parked block's remembered numeric index.
        anchor = command.get('insert_anchor')
        if anchor and result.valid:
            if not isinstance(anchor, dict) or any(key not in ('parent_id','before_id','edge','run_ids') for key in anchor):
                raise CommandError('invalid_boundary', 'invalid text insertion anchor')
            parent = _node(result.doc, anchor['parent_id'])
            _ordinary_parent(parent)
            old_ids = {part.id for part in state.doc.root.walk()}
            run_ids = anchor.get('run_ids', [])
            if not isinstance(run_ids, list) or any(not isinstance(part, str) for part in run_ids):
                raise CommandError('invalid_boundary', 'text run IDs must be a list of strings')
            added = [part for part in parent.children if part.id not in old_ids or part.id in run_ids]
            if added:
                parent.children = [part for part in parent.children if part not in added]
                position = _position(parent, anchor)
                parent.children[position:position] = added
                if render(result.doc) != command['text']:
                    raise CommandError('invalid_boundary', 'text insertion cannot reorder existing enabled content')
                result.doc = refresh_document(result.doc)
        # Block UI's Prompt Control interval notation is translated to PLv3 by
        # its input adapter. Mark only exact translated shells as prompt rows;
        # manually authored/named blocks keep their ordinary block identity.
        spans = command.get("prompt_spans", [])
        if not isinstance(spans, list):
            raise CommandError("invalid_span", "prompt_spans must be a list")
        if spans and result.valid:
            rows = {}
            def visit(row):
                if row["span"]:
                    rows[tuple(row["span"])] = row
                for child in row["children"]:
                    visit(child)
            visit(projection(result)["tree"])
            for span in spans:
                if not isinstance(span, list) or len(span) != 2 or any(type(at) is not int for at in span):
                    raise CommandError("invalid_span", "prompt span needs two UTF-16 offsets")
                row = rows.get(tuple(span))
                if not row or row["kind"] != "group" or row["form"] != "brace" or row["settings"].get("region"):
                    raise CommandError("invalid_span", "prompt span must match a schedule/weight shell")
                _node(result.doc, row["id"]).meta["presentation"] = "prompt"
        completions = command.get('completion') or []
        if isinstance(completions, dict):
            completions = [completions]
        if not isinstance(completions, list):
            raise CommandError('invalid_completion', 'completion must be an object or a list')
        for completion in completions if result.valid else []:
            # TagAC has already inserted the text and its delimiter. Attach
            # provenance in that same typing edit, without reflowing the source
            # or replacing the native input/caret with a structural UI command.
            span = completion['span']
            def completed_row(row):
                if row['span'] == span and (row['kind'] != 'group' or row['form'] == 'paren' or row['meta'].get('presentation') == 'prompt'):
                    return row
                return next((found for child in row['children'] if (found := completed_row(child))), None)
            row = completed_row(projection(result)['tree'])
            if row:
                node = _node(result.doc, row['id'])
                snapshot = DocNode.from_json(completion['snapshot']); snapshot.enabled = True
                if render(snapshot) == render(node):
                    part = _clone_ids(result.doc, snapshot)
                    part.id, part.sep = node.id, node.sep
                    if node.meta.get('presentation') == 'prompt': part.meta['presentation'] = 'prompt'
                    parent = _parents(result.doc)[node.id]
                    parent.children[parent.children.index(node)] = part
                    node = part
                node.meta['source'] = deepcopy(completion['source'])
    else:
        result.check()
        doc = result.doc
        local_format_id = None
        node = _node(doc, command["id"]) if "id" in command else None
        if node and node.meta.get('lora_invocation') and kind not in ('LocateDetails',):
            raise CommandError('fixed_lora', '请从 LoRA block 设置编辑权重；删除或关闭整个 block')
        if kind == "LocateDetails":
            _locate(result, node.id)
        elif kind == 'SetRegionEnabled':
            if node is None or node.form != 'region':
                raise CommandError('special_setting', 'Select a Region container to enable or bypass its region functionality.')
            if not isinstance(command.get('enabled'), bool):
                raise CommandError('invalid_setting', 'Region functionality enabled must be boolean.')
            if command['enabled']:
                node.meta.pop('region_enabled', None)
            else:
                node.meta['region_enabled'] = False
        elif kind == "SetEnabled":
            if node is doc.root:
                raise CommandError("root_switch", "the document root cannot be switched off")
            parent_map = _parents(doc)
            parent = parent_map[node.id]
            while parent is not doc.root:
                if not parent.enabled:
                    raise CommandError("disabled_ancestor", "enable the parent block first")
                parent = parent_map[parent.id]
            if not isinstance(command["enabled"], bool):
                raise CommandError("invalid_command", "enabled must be boolean")
            # Empty bare entry bodies need braces to remain parsable.
            owner = parent_map[node.id]
            if owner.form in ("schedule_entry", "region_entry", "avg_entry"):
                _explicit(owner)
            node.enabled = command["enabled"]
        elif kind == "Delete":
            parent = _parents(doc).get(node.id)
            if parent is None:
                raise CommandError("root_delete", "the document root cannot be deleted")
            parent.children.remove(node)
            _normalise_schedule(doc, parent)
            if result.selection.get("node_id") in {n.id for n in node.walk()}:
                _locate(result, parent.id)
        elif kind == "SetMetadata":
            patch = command["patch"]
            if not isinstance(patch, dict) or any(k not in ("name", "source", "pool", "occurrence") for k in patch):
                raise CommandError("invalid_metadata", "unsupported editing metadata")
            if "pool" in patch and (node.kind != "group" or node.form == "paren" or (patch["pool"] is not None and (not isinstance(patch["pool"], str) or not patch["pool"]))):
                raise CommandError("invalid_metadata", "pool must be one Class id or null on a block")
            if "pool" in patch:
                if node.form in ('schedule', 'region', 'avg') and patch['pool'] is not None:
                    raise CommandError('container_pool', 'Schedule / Region / AVG 容器不能绑定 Class')
                if node.meta.get('lora') and patch['pool'] != node.meta.get('pool'):
                    raise CommandError('fixed_lora_pool', 'LoRA 的触发词 Class 为固定绑定')
            node.meta.update(deepcopy(patch))
        elif kind == "SetSettings":
            _set_settings(doc, node, command["patch"])
        elif kind == 'SetAvgWeight':
            if node.form != 'avg_entry':
                raise CommandError('special_setting', '请选择 AVG entry')
            value = command['value']
            _number(value)
            if value < 0:
                raise CommandError('invalid_setting', 'AVG 权重必须非负')
            _, index = full_index(doc)
            _local_edits(doc, node, [(index[node.id].spans.fields['avg_weight']['value'], _number(value))])
        elif kind == 'SetLoraStrength':
            from .lora_block import invocation, strengths, token
            reference = invocation(node)
            if not reference: raise CommandError('invalid_lora', '请选择 LoRA block')
            model, clip = strengths(node)
            reference[0].raw = token(node.meta['lora']['relative'], command.get('model', model), command.get('clip', clip))
        elif kind == 'InsertLora':
            from .lora_block import token
            lora = command['lora']
            if not isinstance(lora, dict) or not isinstance(lora.get('id'), str) or not isinstance(command.get('pool_id'), str):
                raise CommandError('invalid_lora', '需要 LoRA 身份和触发词池')
            reference = token(lora.get('relative'))
            existing = next((part for part in doc.root.walk() if part.meta.get('lora', {}).get('id') == lora['id']), None)
            if existing:
                parents = _parents(doc)
                target = existing
                while target is not doc.root:
                    target.enabled = True
                    target = parents[target.id]
                _locate(result, existing.id)
            else:
                part = _clone_ids(doc, _fragment('{ ' + reference + ' }'))
                part.meta.update(lora=deepcopy(lora), name=lora.get('name') or lora['relative'], pool=command['pool_id'])
                part.children[0].meta['lora_invocation'] = True
                _separate(part)
                doc.root.children.append(part)
                format_new_block(doc, part)
                _locate(result, part.id)
        elif kind == "SetPromptSettings":
            changed = _prompt_settings(doc, node, command["patch"])
            if changed and changed.form != 'paren':
                local_format_id = changed.id
                format_new_block(doc, changed)
        elif kind == "SetRegion":
            if node.form == "region_entry":
                _, index = full_index(doc)
                _local_edits(doc, node, [(index[node.id].spans.region_decl, region_head(command["region"]))])
            else:
                _set_settings(doc, node, {"region": command["region"]})
        elif kind == "SetScheduleBoundary":
            if node.form != "schedule_entry":
                raise CommandError("special_setting", "select a schedule entry")
            parent = _parents(doc)[node.id]
            entries = parent.children
            position = entries.index(node)
            _, index = full_index(doc)
            intervals = [index[n.id].settings.schedule for n in entries]
            side, value = command["side"], command["value"]
            _number(value)
            if side == "start":
                lower = intervals[position-1][0] if position else 0
                upper = intervals[position][1]
                if not lower <= value <= upper:
                    raise CommandError("invalid_setting", "boundary crosses the adjacent interval")
                _schedule_head(doc, node, (value, intervals[position][1]))
                if position:
                    _schedule_head(doc, entries[position-1], (intervals[position-1][0], value))
            elif side == "end":
                lower = intervals[position][0]
                upper = intervals[position+1][1] if position+1 < len(entries) else 1
                if not lower <= value <= upper:
                    raise CommandError("invalid_setting", "boundary crosses the adjacent interval")
                _schedule_head(doc, node, (intervals[position][0], value))
                if position+1 < len(entries):
                    _schedule_head(doc, entries[position+1], (value, intervals[position+1][1]))
            else:
                raise CommandError("invalid_command", "boundary side must be start or end")
        elif kind == "WrapSelection":
            ids = command.get("ids") or selection_ids(result, command["span"])
            parent, a, b = _selected(doc, ids)
            _ordinary_parent(parent)
            children = parent.children[a:b+1]
            sep = children[-1].sep
            children[-1].sep = ""
            group = DocNode(_new_id(doc), "group", "", sep=sep, opaque=False,
                            open="{ ", close=" }", children=children, form="brace")
            parent.children[a:b+1] = [group]
            format_new_block(doc, group)
            _locate(result, group.id)
        elif kind == "MoveBlock":
            if node.form == 'avg_entry':
                raise CommandError('entry_owner', 'AVG entry 不能拖拽，请移动其正文 subblock 或完整容器')
            if node is doc.root or node.kind != "group" or node.form == "paren":
                raise CommandError("invalid_move", "move a complete block")
            parent = _node(doc, command["parent_id"])
            if parent.id in {n.id for n in node.walk()}:
                raise CommandError("move_cycle", "a block cannot move into itself or its descendants")
            if command.get("before_id") == node.id or command.get("after_id") == node.id:
                raise CommandError("invalid_boundary", "the source cannot also be the adjacent target")
            owner = _parents(doc)[node.id]
            if node.form in ("schedule_entry", "region_entry", "avg_entry") and owner is not parent:
                raise CommandError("entry_owner", "entry 只能在所属容器内排序")
            if owner is parent and owner.form in ("schedule", "region", "avg"):
                # Reordering a timeline moves bodies between the existing time
                # slots. A region reorder keeps each body with its own head.
                _, original = full_index(doc)
                slots = [original[n.id].settings.schedule for n in owner.children] if owner.form == "schedule" else None
                owner.children.remove(node)
                owner.children.insert(_position(owner, command), node)
                if slots is not None:
                    for item, interval in zip(owner.children, slots):
                        _schedule_head(doc, item, interval)
                result.doc = refresh_document(doc)
                result.check()
                _locate(result, node.id)
                result.revision += 1
                return result
            _ordinary_parent(parent)
            owner.children.remove(node)
            _normalise_schedule(doc, owner)
            position = _position(parent, command)
            if parent.meta.get('lora'): position = max(1, position)
            _separate(node)
            parent.children.insert(position, node)
            _normalise_schedule(doc, parent)
            _locate(result, node.id)
        elif kind == 'MergeLibraryBlock':
            parent = _node(doc, command['parent_id']); _ordinary_parent(parent)
            if command.get('source', {}).get('kind') != 'block' or not isinstance(command.get('occurrence'), list):
                raise CommandError('invalid_asset', '合并需要 Library Block 来源')
            source = DocNode.from_json(command['snapshot'])
            _merge_pool_block(doc, parent, source, command)
            _normalise_schedule(doc, parent)
            _locate(result, parent.id)
        elif kind in ("InsertBlock", "InsertEntry", "InsertLibraryBlock", "EnableCandidate", "InsertLibraryPrompts"):
            parent = _node(doc, command["parent_id"])
            position = _position(parent, command)
            if parent.meta.get('lora'): position = max(1, position)
            if kind == "InsertEntry":
                if parent.form not in ("schedule", "region", "avg"):
                    raise CommandError("special_boundary", "只能在 Schedule、Region 或 AVG 容器内新建 entry")
                if any(key in command for key in ("snapshot", "text", "form")):
                    raise CommandError("special_boundary", "entry 必须新建，不能由外部 block 转换")
            else:
                _ordinary_parent(parent)
            if kind == "EnableCandidate":
                occurrence = command["occurrence"]
                matches = [n for n in parent.children if n.meta.get("occurrence") == occurrence]
                if matches:
                    matches[0].enabled = True
                    _locate(result, matches[0].id)
                    result.doc = refresh_document(doc)
                    if doc.root.meta.get('_layout_indent') == 4:
                        format_document(result.doc)
                    result.check()
                    result.revision += 1
                    return result
            if kind == "InsertEntry":
                source = _fragment("{ }")
            elif kind == "InsertBlock" and "form" in command:
                source = _new_container(command["form"])
            elif "snapshot" in command:
                source = DocNode.from_json(command["snapshot"])
            else:
                source = _fragment(command.get("text", "{ }"))
            if kind != "EnableCandidate" and (source.kind != "group" or source.form == "paren"):
                raise CommandError("invalid_asset", "insertion needs an expanded block snapshot")
            if source.form in ("schedule_entry", "region_entry", "avg_entry"):
                raise CommandError("entry_owner", "entry 不能独立插入，请插入完整容器或正文 subblock")
            if kind == "InsertLibraryPrompts":
                _ordinary_parent(parent)
                pieces = _flatten(source)
                for piece in pieces:
                    # Reparse attention/items; generated IDs must include descendants.
                    parsed = _fragment(piece.raw)
                    part = _clone_ids(doc, parsed)
                    _separate(part)
                    parent.children.insert(position, part)
                    position += 1
                if pieces:
                    _locate(result, parent.children[position-1].id)
            else:
                part = _clone_ids(doc, source)
                part.enabled = True
                if kind in ("InsertLibraryBlock", "EnableCandidate"):
                    if "source" not in command:
                        raise CommandError("invalid_asset", "Library insertion requires source identity")
                    part.meta["source"] = deepcopy(command["source"])
                if kind == "EnableCandidate":
                    part.meta["occurrence"] = deepcopy(command["occurrence"])
                doc.root.children.append(part)
                _attach_entry(doc, parent, part, command.get("entry"))
                doc.root.children.remove(part)
                _separate(part)
                parent.children.insert(position, part)
                if part.kind == 'group' and part.form != 'paren':
                    format_new_block(doc, part)
                _normalise_schedule(doc, parent)
                _locate(result, part.id)
        elif kind == 'CompleteLibrary':
            if node.kind == 'group' and node.form != 'paren': raise CommandError('invalid_completion', '补全不能覆盖完整 block')
            parent = _parents(doc).get(node.id)
            _ordinary_parent(parent)
            span = projection(result)['tree']
            def locate_span(value):
                if value['id'] == node.id: return value['span']
                for child in value['children']:
                    found = locate_span(child)
                    if found is not None: return found
            owned = locate_span(span)
            a, b = command['span']
            if owned is None or a > owned[0] or b < owned[1]: raise CommandError('invalid_completion', '请补全一条完整 prompt')
            part = _clone_ids(doc, DocNode.from_json(command['snapshot']))
            part.sep = node.sep; part.meta['source'] = deepcopy(command['source']); part.enabled = True
            parent.children[parent.children.index(node)] = part
            _locate(result, part.id)
        elif kind == "UpdateLibraryBlock":
            if node.kind != 'group' or node.form in ('root', 'paren', 'schedule_entry', 'region_entry', 'avg_entry'):
                raise CommandError('invalid_asset', '请选择完整 Library block')
            parsed = _clone_ids(doc, DocNode.from_json(command['snapshot']))
            if parsed.kind != 'group' or parsed.form == 'paren': raise CommandError('invalid_asset', '需要完整 block 快照')
            parsed.id, parsed.sep, parsed.enabled = node.id, node.sep, node.enabled
            parsed.meta['source'] = deepcopy(command['source'])
            node.__dict__.update(parsed.__dict__)
            _locate(result, node.id)
        elif kind == "ReplaceItem":
            if node.kind == "group" and node.form != "paren":
                raise CommandError("invalid_command", "edit a block's TextRun rather than replacing its subtree")
            # Like PLv3 detail span edits, a pasted comma list is reparsed into
            # siblings. Keep the first row's identity and every parked switch.
            parts = from_text(command["text"], recover=False).root.children
            if len(parts) != 1:
                parent = _parents(doc)[node.id]
                replacements = []
                for index, part in enumerate(parts):
                    replacement = _clone_ids(doc, part)
                    replacement.enabled = node.enabled
                    if index == 0:
                        replacement.id, replacement.meta = node.id, deepcopy(node.meta)
                    replacements.append(replacement)
                if replacements:
                    replacements[-1].sep = node.sep
                at = parent.children.index(node)
                parent.children[at:at + 1] = replacements
            else:
                parsed = parts[0]
                if node.kind == parsed.kind and len(node.children) == len(parsed.children):
                    _replace_shell(node, parsed)
                else:
                    # An explicit item-level attention wrapper changes AST shape.
                    # Keep the row identity; new atom IDs are allocated, never borrowed.
                    parsed = _clone_ids(doc, parsed)
                    parsed.id, parsed.sep, parsed.enabled, parsed.meta = node.id, node.sep, node.enabled, node.meta
                    node.__dict__.update(parsed.__dict__)
        elif kind == "EditTextRun":
            ids = command["ids"]
            parent, a, b = _selected(doc, ids)
            if any(part.meta.get('lora_invocation') for part in parent.children[a:b+1]):
                raise CommandError('fixed_lora', 'LoRA 调用项不能作为正文编辑')
            if any(n.kind == "group" and n.form != "paren" for n in parent.children[a:b+1]):
                raise CommandError("invalid_text_run", "TextRun cannot include a child block")
            tree = projection(result)["tree"]
            by_id = {}
            def collect(n):
                by_id[n["id"]] = n
                for c in n["children"]:
                    collect(c)
            collect(tree)
            visible = [by_id[i]["span"] for i in ids if by_id[i]["span"]]
            if not visible:
                raise CommandError("invalid_text_run", "edit disabled items by ID")
            start = python_offset(result.text, visible[0][0])
            end = python_offset(result.text, visible[-1][1])
            result.replace_text(result.text[:start] + command["text"] + result.text[end:])
        else:
            raise CommandError("unknown_command", f"unknown command: {kind}")
        if result.valid and kind not in ("EditTextRun", "LocateDetails"):
            # A switch changes only enabled state. A legacy layout marker must
            # not regenerate separators and discard the user's Enter/blank lines.
            pretty = not command.get('resource_update') and kind not in ('SetEnabled','MoveBlock') and kind not in _LOCAL_INSERT_COMMANDS and kind in _LAYOUT_COMMANDS
            if pretty:
                format_document(result.doc)
            result.doc = refresh_document(result.doc)
            if pretty:
                format_document(result.doc)
            elif kind in _LOCAL_INSERT_COMMANDS:
                inserted = result.doc.find(local_format_id or (result.selection.get('node_id') if kind != 'SetPromptSettings' else None))
                if inserted and inserted.kind == 'group' and inserted.form != 'paren':
                    format_new_block(result.doc, inserted)
        if result.valid:
            result.check()
    # New typing may remove the selected instance; choose a surviving parent/root.
    if result.selection.get("node_id") and result.doc.find(result.selection["node_id"]) is None:
        _locate(result, result.doc.root.id)
    if result.valid and not command.get('resource_update'):
        from .mask_resources import detach_changed
        detach_changed(result.doc)
    result.revision += 1
    return result


def command_response(state: EditorState, command: dict) -> dict:
    next_state = apply_command(state, command)
    return dict(ok=True, state=next_state.to_json(), projection=projection(next_state),
                edit=text_edit(state.text, next_state.text))
