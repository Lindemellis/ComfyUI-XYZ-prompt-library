"""Prompt Library V3 — WriteQueue (single writer) + short-lived read APIs.

Same data-access discipline as the gallery and PLv2: every write goes through the
queue as an op with an `apply(conn)`; every read opens its own short-lived
connection.  No SQL anywhere else.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

from . import db as _db

logger = logging.getLogger(__name__)

_PathLike = Union[str, Path]


class CycleError(Exception):
    """A ref would close a loop.  Spec §5.5: the library never contains one."""


# ---------------------------------------------------------------------------
# WriteQueue
# ---------------------------------------------------------------------------


if '.' in __package__:
    from ..prompt_shared.storage import WriteQueue
else:
    from prompt_shared.storage import WriteQueue


_db_path: Optional[Path] = None
_queue: Optional[WriteQueue] = None


def init(path: _PathLike) -> None:
    global _db_path, _queue
    _db_path = Path(path)
    _queue = WriteQueue(_db_path)
    _queue.start()


def shutdown() -> None:
    if _queue is not None:
        _queue.stop()


def write(op: Any):
    """Enqueue an op and wait for it.  Exceptions from apply() surface here."""
    if _queue is None:
        raise RuntimeError("plv3 repo not initialised")
    return _queue.enqueue(op).result()


def _read() -> sqlite3.Connection:
    if _db_path is None:
        raise RuntimeError("plv3 repo not initialised")
    return _db.connect_read(_db_path)


# ---------------------------------------------------------------------------
# Write ops
# ---------------------------------------------------------------------------


def _next_sort(conn, table: str, where: str, args: tuple) -> int:
    row = conn.execute(
        f"SELECT COALESCE(MAX(sort_index), -1) + 1 AS n FROM {table} WHERE {where}", args
    ).fetchone()
    return int(row["n"])


@dataclass
class CreateFolderOp:
    name: str
    parent_id: int | None = None

    def apply(self, conn) -> int:
        idx = _next_sort(conn, "folders", "parent_id IS ?", (self.parent_id,))
        cur = conn.execute(
            "INSERT INTO folders(parent_id, name, sort_index) VALUES (?, ?, ?)",
            (self.parent_id, self.name, idx),
        )
        return int(cur.lastrowid)


@dataclass
class RenameFolderOp:
    folder_id: int
    name: str

    def apply(self, conn) -> None:
        conn.execute("UPDATE folders SET name = ? WHERE id = ?", (self.name, self.folder_id))


@dataclass
class MoveFolderOp:
    folder_id: int
    parent_id: int | None

    def apply(self, conn) -> None:
        if self.parent_id is not None:
            _assert_not_descendant_folder(conn, self.folder_id, self.parent_id)
        idx = _next_sort(conn, "folders", "parent_id IS ?", (self.parent_id,))
        conn.execute(
            "UPDATE folders SET parent_id = ?, sort_index = ? WHERE id = ?",
            (self.parent_id, idx, self.folder_id),
        )


@dataclass
class DeleteFolderOp:
    folder_id: int

    def apply(self, conn) -> None:
        conn.execute("DELETE FROM folders WHERE id = ?", (self.folder_id,))


@dataclass
class CreateGroupOp:
    name: str
    folder_id: int | None = None
    parent_group_id: int | None = None  # non-null => a true subgroup
    polarity: str = "positive"
    settings: dict = field(default_factory=dict)

    def apply(self, conn) -> int:
        idx = _next_sort(
            conn,
            "groups",
            "folder_id IS ? AND parent_group_id IS ?",
            (self.folder_id, self.parent_group_id),
        )
        cur = conn.execute(
            "INSERT INTO groups(folder_id, parent_group_id, name, sort_index, polarity, "
            "settings_json) VALUES (?, ?, ?, ?, ?, ?)",
            (
                self.folder_id,
                self.parent_group_id,
                self.name,
                idx,
                self.polarity,
                json.dumps(self.settings),
            ),
        )
        return int(cur.lastrowid)


@dataclass
class UpdateGroupOp:
    group_id: int
    name: str | None = None
    polarity: str | None = None
    settings: dict | None = None

    def apply(self, conn) -> None:
        sets, args = [], []
        if self.name is not None:
            sets.append("name = ?")
            args.append(self.name)
        if self.polarity is not None:
            sets.append("polarity = ?")
            args.append(self.polarity)
        if self.settings is not None:
            sets.append("settings_json = ?")
            args.append(json.dumps(self.settings))
        if not sets:
            return
        args.append(self.group_id)
        conn.execute(f"UPDATE groups SET {', '.join(sets)} WHERE id = ?", tuple(args))


@dataclass
class MoveGroupOp:
    """Reparent a group: into a folder (a top-level group), or under another group
    (a true subgroup, which the target then owns)."""

    group_id: int
    folder_id: int | None = None
    parent_group_id: int | None = None

    def apply(self, conn) -> None:
        if self.parent_group_id is not None:
            _assert_not_descendant_group(conn, self.group_id, self.parent_group_id)
            # A subgroup lives under its parent, not directly in a folder.
            folder_id = None
        else:
            folder_id = self.folder_id
        idx = _next_sort(
            conn,
            "groups",
            "folder_id IS ? AND parent_group_id IS ?",
            (folder_id, self.parent_group_id),
        )
        conn.execute(
            "UPDATE groups SET folder_id = ?, parent_group_id = ?, sort_index = ? WHERE id = ?",
            (folder_id, self.parent_group_id, idx, self.group_id),
        )


@dataclass
class DeleteGroupOp:
    group_id: int

    def apply(self, conn) -> None:
        # Subgroups and items cascade; refs pointing here cascade away too, which is
        # what "a ref is a pointer, the group is the entity" means.
        conn.execute("DELETE FROM groups WHERE id = ?", (self.group_id,))


@dataclass
class AddItemOp:
    group_id: int
    kind: str = "prompt"  # prompt | lora | ref
    text: str = ""
    ref_group_id: int | None = None
    weight: float | None = None

    def apply(self, conn) -> int:
        if self.kind == "ref":
            if self.ref_group_id is None:
                raise ValueError("a ref item needs ref_group_id")
            _assert_no_cycle(conn, self.group_id, self.ref_group_id)
        idx = _next_sort(conn, "items", "group_id = ?", (self.group_id,))
        cur = conn.execute(
            "INSERT INTO items(group_id, kind, sort_index, text, ref_group_id, weight) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (self.group_id, self.kind, idx, self.text, self.ref_group_id, self.weight),
        )
        return int(cur.lastrowid)


@dataclass
class UpdateItemOp:
    item_id: int
    text: str | None = None
    weight: float | None = None
    sort_index: int | None = None

    def apply(self, conn) -> None:
        sets, args = [], []
        if self.text is not None:
            sets.append("text = ?")
            args.append(self.text)
        if self.weight is not None:
            sets.append("weight = ?")
            args.append(self.weight)
        if self.sort_index is not None:
            sets.append("sort_index = ?")
            args.append(self.sort_index)
        if not sets:
            return
        args.append(self.item_id)
        conn.execute(f"UPDATE items SET {', '.join(sets)} WHERE id = ?", tuple(args))


@dataclass
class DeleteItemOp:
    item_id: int

    def apply(self, conn) -> None:
        conn.execute("DELETE FROM items WHERE id = ?", (self.item_id,))


@dataclass
class ReorderItemsOp:
    group_id: int
    item_ids: list[int]

    def apply(self, conn) -> None:
        for i, item_id in enumerate(self.item_ids):
            conn.execute(
                "UPDATE items SET sort_index = ? WHERE id = ? AND group_id = ?",
                (i, item_id, self.group_id),
            )


@dataclass
class AppendNewItemsOp:
    """Spec §5.3 — the blur-sync write.

    Items present in the document but not in the group are appended (a rewritten
    item is therefore "a new one, plus the old one silently disabled", which is the
    required semantics without a dialog).  Nothing is ever deleted here, and nothing
    is disabled either: "disabled" simply means "not in the text", which is not a
    fact the DB stores at all (spec §5.2).
    """

    group_id: int
    texts: list[str]

    def apply(self, conn) -> list[int]:
        have = {
            r["text"]
            for r in conn.execute(
                "SELECT text FROM items WHERE group_id = ?", (self.group_id,)
            )
        }
        added: list[int] = []
        idx = _next_sort(conn, "items", "group_id = ?", (self.group_id,))
        seen: set[str] = set()
        for text in self.texts:
            text = text.strip()
            if not text or text in have or text in seen:
                continue  # duplicates in the text collapse to one row (W06)
            seen.add(text)
            kind = "lora" if text.startswith("<lora:") else "prompt"
            cur = conn.execute(
                "INSERT INTO items(group_id, kind, sort_index, text) VALUES (?, ?, ?, ?)",
                (self.group_id, kind, idx, text),
            )
            added.append(int(cur.lastrowid))
            idx += 1
        return added


@dataclass
class SavePresetOp:
    group_id: int
    name: str
    body: dict

    def apply(self, conn) -> int:
        row = conn.execute(
            "SELECT id FROM presets WHERE group_id = ? AND name = ?",
            (self.group_id, self.name),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE presets SET body_json = ? WHERE id = ?",
                (json.dumps(self.body), row["id"]),
            )
            return int(row["id"])
        idx = _next_sort(conn, "presets", "group_id = ?", (self.group_id,))
        cur = conn.execute(
            "INSERT INTO presets(group_id, name, sort_index, body_json) VALUES (?, ?, ?, ?)",
            (self.group_id, self.name, idx, json.dumps(self.body)),
        )
        return int(cur.lastrowid)


@dataclass
class DeletePresetOp:
    preset_id: int

    def apply(self, conn) -> None:
        conn.execute("DELETE FROM presets WHERE id = ?", (self.preset_id,))


# --- documents: a whole prompt, stored verbatim -----------------------------


@dataclass
class SaveDocumentOp:
    """Store a whole document.  Same name in the same folder REPLACES it.

    Both halves are kept: `text` is what compiles, `doc_json` is the document the text
    was rendered from — and an item switched off lives only in the latter.  Saving the
    text alone would drop every disabled item, silently, at the moment of saving.
    """

    name: str
    text: str
    doc_json: str = ""
    folder_id: int | None = None

    def apply(self, conn) -> int:
        # `folder_id IS ?`, not `= ?`: the root folder is NULL, and NULL = NULL is not
        # true in SQL.  See db._v3 for why the uniqueness lives here and not in an index.
        row = conn.execute(
            "SELECT id FROM documents WHERE folder_id IS ? AND name = ?",
            (self.folder_id, self.name),
        ).fetchone()
        now = int(time.time())
        if row:
            conn.execute(
                "UPDATE documents SET text = ?, doc_json = ?, updated_at = ? WHERE id = ?",
                (self.text, self.doc_json, now, int(row["id"])),
            )
            return int(row["id"])
        idx = _next_sort(conn, "documents", "folder_id IS ?", (self.folder_id,))
        cur = conn.execute(
            "INSERT INTO documents(folder_id, name, sort_index, text, doc_json, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (self.folder_id, self.name, idx, self.text, self.doc_json, now),
        )
        return int(cur.lastrowid)


@dataclass
class RenameDocumentOp:
    document_id: int
    name: str

    def apply(self, conn) -> None:
        conn.execute(
            "UPDATE documents SET name = ? WHERE id = ?", (self.name, self.document_id)
        )


@dataclass
class MoveDocumentOp:
    document_id: int
    folder_id: int | None

    def apply(self, conn) -> None:
        idx = _next_sort(conn, "documents", "folder_id IS ?", (self.folder_id,))
        conn.execute(
            "UPDATE documents SET folder_id = ?, sort_index = ? WHERE id = ?",
            (self.folder_id, idx, self.document_id),
        )


@dataclass
class DeleteDocumentOp:
    document_id: int

    def apply(self, conn) -> None:
        conn.execute("DELETE FROM documents WHERE id = ?", (self.document_id,))


# ---------------------------------------------------------------------------
# Cycle detection (spec §5.5, layer 1: the library never contains a loop)
# ---------------------------------------------------------------------------


def _refs_of(conn, group_id: int) -> list[int]:
    return [
        int(r["ref_group_id"])
        for r in conn.execute(
            "SELECT ref_group_id FROM items WHERE group_id = ? AND kind = 'ref' "
            "AND ref_group_id IS NOT NULL",
            (group_id,),
        )
    ]


def _assert_not_descendant_folder(conn, folder_id: int, target_id: int) -> None:
    """A folder cannot be moved inside itself."""
    node = target_id
    while node is not None:
        if node == folder_id:
            raise CycleError("a folder cannot be moved into its own subtree")
        row = conn.execute("SELECT parent_id FROM folders WHERE id = ?", (node,)).fetchone()
        node = row["parent_id"] if row else None


def _assert_not_descendant_group(conn, group_id: int, target_id: int) -> None:
    """A group cannot become a subgroup of one of its own subgroups."""
    node = target_id
    while node is not None:
        if node == group_id:
            raise CycleError("a group cannot be moved into its own subtree")
        row = conn.execute(
            "SELECT parent_group_id FROM groups WHERE id = ?", (node,)
        ).fetchone()
        node = row["parent_group_id"] if row else None


def _assert_no_cycle(conn, owner_id: int, target_id: int) -> None:
    """Refuse a ref from `owner` to `target` if owner is reachable from target."""
    if owner_id == target_id:
        raise CycleError("a group cannot reference itself")
    seen = {target_id}
    stack = [target_id]
    while stack:
        current = stack.pop()
        for nxt in _refs_of(conn, current):
            if nxt == owner_id:
                raise CycleError(f"group {owner_id} is already reachable from {target_id}")
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def _row(r) -> dict:
    return dict(r) if r is not None else None


def list_folders() -> list[dict]:
    with _read() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM folders ORDER BY sort_index, name"
        )]


def list_groups() -> list[dict]:
    with _read() as conn:
        return [
            {**dict(r), "settings": json.loads(r["settings_json"] or "{}")}
            for r in conn.execute("SELECT * FROM groups ORDER BY sort_index, name")
        ]


def get_group(group_id: int) -> dict | None:
    with _read() as conn:
        r = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
        if r is None:
            return None
        return {**dict(r), "settings": json.loads(r["settings_json"] or "{}")}


def list_items(group_id: int) -> list[dict]:
    with _read() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM items WHERE group_id = ? ORDER BY sort_index, id",
                (group_id,),
            )
        ]


def get_item(item_id: int) -> dict | None:
    with _read() as conn:
        r = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return dict(r) if r is not None else None


def list_presets(group_id: int) -> list[dict]:
    with _read() as conn:
        return [
            {**dict(r), "body": json.loads(r["body_json"] or "{}")}
            for r in conn.execute(
                "SELECT * FROM presets WHERE group_id = ? ORDER BY sort_index, name",
                (group_id,),
            )
        ]


def list_preset_names() -> list[dict]:
    """Every preset in the library, id + group + name only.

    The autocomplete offers `[group ▸ preset]` for every preset there is, so it needs
    the lot in one query — one `list_presets` per group would be a round trip per row
    of the tree.  The bodies are not read: expansion happens server-side from the id.
    """
    with _read() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT id, group_id, name FROM presets ORDER BY group_id, sort_index, name"
            )
        ]


def get_preset(preset_id: int) -> dict | None:
    with _read() as conn:
        r = conn.execute("SELECT * FROM presets WHERE id = ?", (preset_id,)).fetchone()
        if r is None:
            return None
        return {**dict(r), "body": json.loads(r["body_json"] or "{}")}


def list_documents() -> list[dict]:
    """Every saved document — WITHOUT its text.

    The library tree draws a row per document and nothing more; shipping every stored
    prompt with the tree would make the window's first fetch grow with the archive.
    `size` is there so the row can say how big the thing is before you open it.
    """
    with _read() as conn:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT id, folder_id, name, sort_index, updated_at, "
                "length(text) AS size FROM documents ORDER BY sort_index, name"
            )
        ]


def get_document(document_id: int) -> dict | None:
    with _read() as conn:
        r = conn.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        return dict(r) if r is not None else None


def group_path(group_id: int) -> str | None:
    """`folder.subfolder.group.subgroup` — the dotted path a `[ref]` is written as."""
    with _read() as conn:
        return _group_path(conn, group_id)


def _group_path(conn, group_id: int) -> str | None:
    g = conn.execute("SELECT * FROM groups WHERE id = ?", (group_id,)).fetchone()
    if g is None:
        return None
    parts = [g["name"]]
    parent = g["parent_group_id"]
    folder_id = g["folder_id"]
    while parent is not None:
        p = conn.execute("SELECT * FROM groups WHERE id = ?", (parent,)).fetchone()
        if p is None:
            break
        parts.append(p["name"])
        folder_id = p["folder_id"]
        parent = p["parent_group_id"]
    while folder_id is not None:
        f = conn.execute("SELECT * FROM folders WHERE id = ?", (folder_id,)).fetchone()
        if f is None:
            break
        parts.append(f["name"])
        folder_id = f["parent_id"]
    return ".".join(reversed(parts))


def find_by_path(path: str) -> int | None:
    """Resolve `a.b.c` to a group id, or None (spec W09: not an error)."""
    parts = [p for p in (path or "").split(".") if p]
    if not parts:
        return None
    with _read() as conn:
        folder_id = None
        i = 0
        # Walk folders while the next name is a folder at this level.
        while i < len(parts):
            f = conn.execute(
                "SELECT id FROM folders WHERE parent_id IS ? AND name = ?",
                (folder_id, parts[i]),
            ).fetchone()
            if f is None:
                break
            folder_id = int(f["id"])
            i += 1
        if i >= len(parts):
            return None  # the path names a folder, not a group
        g = conn.execute(
            "SELECT id FROM groups WHERE folder_id IS ? AND parent_group_id IS NULL "
            "AND name = ?",
            (folder_id, parts[i]),
        ).fetchone()
        if g is None:
            return None
        group_id = int(g["id"])
        # The rest of the path walks true subgroups.
        for name in parts[i + 1 :]:
            sub = conn.execute(
                "SELECT id FROM groups WHERE parent_group_id = ? AND name = ?",
                (group_id, name),
            ).fetchone()
            if sub is None:
                return None
            group_id = int(sub["id"])
        return group_id
