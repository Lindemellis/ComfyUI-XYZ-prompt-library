"""Prompt Library V3 — WriteQueue (single writer) + short-lived read APIs.

Same data-access discipline as the gallery and PLv2: every write goes through the
queue as an op with an `apply(conn)`; every read opens its own short-lived
connection.  No SQL anywhere else.
"""
from __future__ import annotations

import itertools
import json
import logging
import queue
import sqlite3
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union

from . import db as _db

logger = logging.getLogger(__name__)

_PathLike = Union[str, Path]
_STOP = object()
_CRASH_RESTART_SLEEP_SEC = 0.5


class CycleError(Exception):
    """A ref would close a loop.  Spec §5.5: the library never contains one."""


# ---------------------------------------------------------------------------
# WriteQueue
# ---------------------------------------------------------------------------


class WriteQueue:
    """Single-writer queue.  One op -> one BEGIN IMMEDIATE / COMMIT."""

    def __init__(self, db_path: _PathLike) -> None:
        self._db_path = Path(db_path)
        self._q: "queue.Queue[tuple[int, Any, Optional[Future]]]" = queue.Queue()
        self._seq = itertools.count()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def enqueue(self, op: Any) -> Future:
        if not hasattr(op, "apply"):
            raise TypeError("op must implement .apply(conn)")
        fut: Future = Future()
        self._q.put((next(self._seq), op, fut))
        return fut

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._supervised, name="xyz-plv3-writer", daemon=True
            )
            self._thread.start()

    def stop(self, timeout: float = 0.5) -> bool:
        with self._lock:
            t = self._thread
            if t is None:
                return True
            self._stop.set()
            self._q.put((-1, _STOP, None))
        t.join(timeout=timeout)
        if not t.is_alive():
            with self._lock:
                self._thread = None
            return True
        return False

    def _supervised(self) -> None:
        while not self._stop.is_set():
            try:
                self._loop()
                return
            except Exception:  # pragma: no cover - defensive
                logger.exception("plv3 writer loop crashed; restarting")
                time.sleep(_CRASH_RESTART_SLEEP_SEC)

    def _loop(self) -> None:
        conn = _db.connect_write(self._db_path)
        try:
            while not self._stop.is_set():
                _seq, op, fut = self._q.get(block=True)
                if op is _STOP:
                    return
                self._run(conn, op, fut)
        finally:
            try:
                conn.close()
            except Exception:  # pragma: no cover
                logger.exception("error closing plv3 write connection")

    def _run(self, conn: sqlite3.Connection, op: Any, fut: Optional[Future]) -> None:
        open_tx = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            open_tx = True
            result = op.apply(conn)
            conn.execute("COMMIT")
            open_tx = False
            if fut is not None and not fut.done():
                fut.set_result(result)
        except BaseException as exc:
            if open_tx:
                try:
                    conn.execute("ROLLBACK")
                except Exception:  # pragma: no cover
                    logger.exception("ROLLBACK failed")
            if fut is not None and not fut.done():
                fut.set_exception(exc)
            if not isinstance(exc, Exception):
                raise


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


def get_preset(preset_id: int) -> dict | None:
    with _read() as conn:
        r = conn.execute("SELECT * FROM presets WHERE id = ?", (preset_id,)).fetchone()
        if r is None:
            return None
        return {**dict(r), "body": json.loads(r["body_json"] or "{}")}


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
