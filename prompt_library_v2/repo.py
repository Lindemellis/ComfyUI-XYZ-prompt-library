"""Prompt Library V2 — repository (WriteQueue + read APIs).

Write side:
  All mutations go through WriteQueue.enqueue_write(priority, op).
  Each op owns its own BEGIN IMMEDIATE / op.apply(conn) / COMMIT transaction.

Read side:
  Every read function opens a short-lived connect_read() connection (WAL →
  many readers concurrently). Never hold a read connection across requests.

Usage:
  Call init(db_path) once at startup (done by prompt_library_v2.__init__.setup()).
  Call stop() on ComfyUI shutdown.
"""

from __future__ import annotations

import itertools
import logging
import queue
import sqlite3
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from . import db as _db

logger = logging.getLogger("xyz.plv2.repo")

__all__ = [
    # Priority constants
    "HIGH", "MID", "LOW",
    # Lifecycle
    "init", "stop",
    # Write ops
    "WriteQueue",
    "CreateNodeOp",
    "UpdateNodeOp",
    "DeleteNodeOp",
    "MoveNodeOp",
    "UpsertPromptOp",
    "DeletePromptOp",
    "ReorderPromptsOp",
    "UpsertTriggerOp",
    "DeleteTriggerOp",
    "ReplaceAutoTriggersOp",
    "UpsertCommonFormatOp",
    "UpsertCommonDelimiterOp",
    "CreateTemplateSlotOp",
    "UpdateTemplateSlotOp",
    "DeleteTemplateSlotOp",
    "CreateTemplatePromptOp",
    "UpdateTemplatePromptOp",
    "DeleteTemplatePromptOp",
    # Read APIs
    "get_prompt",
    "get_node",
    "get_node_by_path",
    "get_children",
    "get_subtree_paths",
    "get_tree",
    "get_prompts",
    "get_triggers",
    "get_all_triggers",
    "get_common_formats",
    "get_common_delimiters",
    "get_template_slots",
    "get_template_slot_prompts",
    "enqueue_write",
]

HIGH: int = 0
MID: int = 1
LOW: int = 2

_VALID_PRIORITIES = frozenset((HIGH, MID, LOW))
_LOW_YIELD_THRESHOLD: int = 200
_CRASH_RESTART_SLEEP_SEC: float = 0.02

_PathLike = Union[str, Path]

# ---------------------------------------------------------------------------
# Module-level state (set by init())
# ---------------------------------------------------------------------------

_DB_PATH: Optional[Path] = None
_WRITE_QUEUE: Optional["WriteQueue"] = None


def init(db_path: _PathLike) -> None:
    """Initialise the module: store the DB path and start the write queue."""
    global _DB_PATH, _WRITE_QUEUE
    _DB_PATH = Path(db_path)
    _WRITE_QUEUE = WriteQueue(_DB_PATH)
    _WRITE_QUEUE.start()


def stop(timeout: float = 0.2) -> bool:
    """Drain and stop the write queue. Returns True if joined in time."""
    global _WRITE_QUEUE
    if _WRITE_QUEUE is not None:
        return _WRITE_QUEUE.stop(timeout=timeout)
    return True


def enqueue_write(priority: int, op: Any) -> Future:
    """Enqueue a write op. Raises RuntimeError if init() was not called."""
    if _WRITE_QUEUE is None:
        raise RuntimeError("plv2 repo not initialised — call init() first")
    return _WRITE_QUEUE.enqueue_write(priority, op)


# ---------------------------------------------------------------------------
# WriteQueue
# ---------------------------------------------------------------------------

class _StopSentinel:
    def apply(self, conn: sqlite3.Connection) -> None:
        return None


_STOP = _StopSentinel()


class WriteQueue:
    """Single-writer priority queue. One op → one BEGIN IMMEDIATE / COMMIT."""

    def __init__(self, db_path: _PathLike) -> None:
        self._db_path = Path(db_path)
        self._pq: "queue.PriorityQueue[tuple[int, int, Any, Optional[Future]]]" = (
            queue.PriorityQueue()
        )
        self._seq = itertools.count()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._thread_lock = threading.Lock()

    def enqueue_write(self, priority: int, op: Any) -> Future:
        if priority not in _VALID_PRIORITIES:
            raise ValueError(f"unknown priority: {priority!r}")
        if not hasattr(op, "apply"):
            raise TypeError("op must implement .apply(conn)")
        fut: Future = Future()
        self._pq.put((priority, next(self._seq), op, fut))
        return fut

    def start(self) -> None:
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._supervised_loop,
                name="xyz-plv2-writer",
                daemon=True,
            )
            self._thread.start()

    def stop(self, timeout: float = 0.2) -> bool:
        with self._thread_lock:
            t = self._thread
            if t is None:
                return True
            self._stop_event.set()
            self._pq.put((HIGH, -1, _STOP, None))
        t.join(timeout=timeout)
        joined = not t.is_alive()
        if joined:
            with self._thread_lock:
                self._thread = None
        return joined

    def _supervised_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._writer_loop()
                return
            except Exception:
                logger.exception("plv2 writer loop crashed; restarting")
                time.sleep(_CRASH_RESTART_SLEEP_SEC)

    def _writer_loop(self) -> None:
        conn = _db.connect_write(self._db_path)
        low_streak = 0
        try:
            while not self._stop_event.is_set():
                priority, _seq, op, fut = self._pq.get(block=True)

                if op is _STOP:
                    return

                if priority == LOW:
                    low_streak += 1
                    if (
                        low_streak >= _LOW_YIELD_THRESHOLD
                        and not self._pq.empty()
                    ):
                        self._pq.put((priority, _seq, op, fut))
                        low_streak = 0
                        continue
                else:
                    low_streak = 0

                self._run_op(conn, op, fut)
        finally:
            try:
                conn.close()
            except Exception:
                logger.exception("error closing plv2 write connection")

    def _run_op(
        self,
        conn: sqlite3.Connection,
        op: Any,
        fut: Optional[Future],
    ) -> None:
        tx_open = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            tx_open = True
            result = op.apply(conn)
            conn.execute("COMMIT")
            tx_open = False
            if fut is not None and not fut.done():
                fut.set_result(result)
        except BaseException as exc:
            if tx_open:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    logger.exception("ROLLBACK failed")
            if fut is not None and not fut.done():
                fut.set_exception(exc)
            if not isinstance(exc, Exception):
                raise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> int:
    return int(time.time())


def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return dict(row)


def _rows_to_list(rows) -> List[Dict[str, Any]]:
    return [dict(r) for r in rows]


def _db_path() -> Path:
    if _DB_PATH is None:
        raise RuntimeError("plv2 repo not initialised — call init() first")
    return _DB_PATH


# ---------------------------------------------------------------------------
# Write ops — Nodes
# ---------------------------------------------------------------------------

@dataclass
class CreateNodeOp:
    """Insert a new node into the tree. Returns the new row id."""
    parent_id: Optional[int]
    name: str
    full_path: str
    has_template: bool = False
    has_prompts: bool = True
    pos_neg: str = "positive"
    order_index: int = 0

    def apply(self, conn: sqlite3.Connection) -> int:
        ts = _now()
        cur = conn.execute(
            """
            INSERT INTO nodes
                (parent_id, name, full_path, has_template, has_prompts,
                 pos_neg, order_index, created_at, updated_at)
            VALUES
                (:parent_id, :name, :full_path, :has_template, :has_prompts,
                 :pos_neg, :order_index, :ts, :ts)
            """,
            {
                "parent_id": self.parent_id,
                "name": self.name,
                "full_path": self.full_path,
                "has_template": int(self.has_template),
                "has_prompts": int(self.has_prompts),
                "pos_neg": self.pos_neg,
                "order_index": self.order_index,
                "ts": ts,
            },
        )
        return cur.lastrowid


@dataclass
class UpdateNodeOp:
    """Partial update of node fields. Only non-None kwargs are written."""
    node_id: int
    name: Optional[str] = None
    full_path: Optional[str] = None
    has_template: Optional[bool] = None
    has_prompts: Optional[bool] = None
    pos_neg: Optional[str] = None
    shuffle: Optional[bool] = None
    random_mode: Optional[str] = None
    select_min: Optional[int] = None
    select_max: Optional[int] = None
    dropout_rate: Optional[float] = None
    format: Optional[str] = None
    delimiter: Optional[str] = None
    order_index: Optional[int] = None

    def apply(self, conn: sqlite3.Connection) -> None:
        fields = {
            "name": self.name,
            "full_path": self.full_path,
            "has_template": None if self.has_template is None else int(self.has_template),
            "has_prompts": None if self.has_prompts is None else int(self.has_prompts),
            "pos_neg": self.pos_neg,
            "shuffle": None if self.shuffle is None else int(self.shuffle),
            "random_mode": self.random_mode,
            "select_min": self.select_min,
            "select_max": self.select_max,
            "dropout_rate": self.dropout_rate,
            "format": self.format,
            "delimiter": self.delimiter,
            "order_index": self.order_index,
        }
        updates = {k: v for k, v in fields.items() if v is not None}
        if not updates:
            return
        updates["updated_at"] = _now()
        updates["node_id"] = self.node_id
        set_clause = ", ".join(f"{k} = :{k}" for k in updates if k != "node_id")
        conn.execute(
            f"UPDATE nodes SET {set_clause} WHERE id = :node_id",
            updates,
        )


@dataclass
class DeleteNodeOp:
    """Delete a node and its entire subtree (ON DELETE CASCADE handles children,
    prompts, and triggers automatically)."""
    node_id: int

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM nodes WHERE id = ?", (self.node_id,))


@dataclass
class MoveNodeOp:
    """Move a node to a new parent, updating full_path for the entire subtree.

    old_full_path and new_full_path are the paths before/after the move.
    All descendants are updated with a single REPLACE on full_path.
    """
    node_id: int
    new_parent_id: Optional[int]
    new_name: str
    old_full_path: str
    new_full_path: str

    def apply(self, conn: sqlite3.Connection) -> None:
        ts = _now()
        # Cascade rename: all descendants whose path starts with old_full_path
        # get their path prefix replaced. The node itself is included via LIKE.
        conn.execute(
            """
            UPDATE nodes
            SET full_path = :new_prefix || SUBSTR(full_path, :old_len + 1),
                updated_at = :ts
            WHERE full_path = :old_path
               OR full_path LIKE :old_prefix_glob
            """,
            {
                "new_prefix": self.new_full_path,
                "old_len": len(self.old_full_path),
                "old_path": self.old_full_path,
                "old_prefix_glob": self.old_full_path + ".%",
                "ts": ts,
            },
        )
        # Update parent and name on the moved node itself.
        conn.execute(
            """
            UPDATE nodes
            SET parent_id = ?, name = ?, updated_at = ?
            WHERE id = ?
            """,
            (self.new_parent_id, self.new_name, ts, self.node_id),
        )


# ---------------------------------------------------------------------------
# Write ops — Prompts
# ---------------------------------------------------------------------------

@dataclass
class UpsertPromptOp:
    """Insert or update a prompt row. Returns the row id."""
    node_id: int
    content: str
    weight: float = 1.0
    enabled: bool = True
    order_index: int = 0
    source: str = "custom"
    prompt_id: Optional[int] = None  # set to UPDATE an existing row

    def apply(self, conn: sqlite3.Connection) -> int:
        ts = _now()
        if self.prompt_id is not None:
            conn.execute(
                """
                UPDATE prompts
                SET content = ?, weight = ?, enabled = ?, order_index = ?,
                    updated_at = ?
                WHERE id = ? AND node_id = ?
                """,
                (
                    self.content, self.weight, int(self.enabled),
                    self.order_index, ts,
                    self.prompt_id, self.node_id,
                ),
            )
            return self.prompt_id
        cur = conn.execute(
            """
            INSERT INTO prompts
                (node_id, content, weight, enabled, order_index, source,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                self.node_id, self.content, self.weight, int(self.enabled),
                self.order_index, self.source, ts, ts,
            ),
        )
        return cur.lastrowid


@dataclass
class DeletePromptOp:
    """Delete a single prompt. Refuses to delete template-source prompts."""
    prompt_id: int
    allow_template: bool = False  # safety guard; set True only in Phase 2 tooling

    def apply(self, conn: sqlite3.Connection) -> None:
        if not self.allow_template:
            row = conn.execute(
                "SELECT source FROM prompts WHERE id = ?", (self.prompt_id,)
            ).fetchone()
            if row and row[0] == "template":
                raise ValueError(
                    f"prompt {self.prompt_id} is template-locked and cannot be deleted"
                )
        conn.execute("DELETE FROM prompts WHERE id = ?", (self.prompt_id,))


@dataclass
class ReorderPromptsOp:
    """Bulk-update order_index for a list of prompts.

    order_map: {prompt_id: new_order_index}
    """
    node_id: int
    order_map: Dict[int, int]

    def apply(self, conn: sqlite3.Connection) -> None:
        ts = _now()
        for prompt_id, idx in self.order_map.items():
            conn.execute(
                "UPDATE prompts SET order_index = ?, updated_at = ? WHERE id = ? AND node_id = ?",
                (idx, ts, prompt_id, self.node_id),
            )


# ---------------------------------------------------------------------------
# Write ops — Triggers
# ---------------------------------------------------------------------------

@dataclass
class UpsertTriggerOp:
    """Insert a trigger. Fails if trigger_text is already taken by another node."""
    node_id: int
    trigger_text: str
    is_auto: bool = False

    def apply(self, conn: sqlite3.Connection) -> int:
        ts = _now()
        # Check for existing trigger_text conflict before inserting.
        existing = conn.execute(
            "SELECT id, node_id FROM triggers WHERE trigger_text = ?",
            (self.trigger_text,),
        ).fetchone()
        if existing:
            raise ValueError(
                f"trigger '{self.trigger_text}' already exists"
                + (" for this node" if existing[1] == self.node_id
                   else f" (owned by node {existing[1]})")
            )
        cur = conn.execute(
            "INSERT INTO triggers (node_id, trigger_text, is_auto, created_at) VALUES (?, ?, ?, ?)",
            (self.node_id, self.trigger_text, int(self.is_auto), ts),
        )
        return cur.lastrowid


@dataclass
class DeleteTriggerOp:
    """Delete a single trigger by id. Cannot delete is_auto triggers via normal flow."""
    trigger_id: int
    allow_auto: bool = False

    def apply(self, conn: sqlite3.Connection) -> None:
        if not self.allow_auto:
            row = conn.execute(
                "SELECT is_auto FROM triggers WHERE id = ?", (self.trigger_id,)
            ).fetchone()
            if row and row[0]:
                raise ValueError(
                    f"trigger {self.trigger_id} is auto-computed and cannot be manually deleted"
                )
        conn.execute("DELETE FROM triggers WHERE id = ?", (self.trigger_id,))


@dataclass
class ReplaceAutoTriggersOp:
    """Replace all is_auto triggers for a set of nodes atomically.

    new_auto: {node_id: trigger_text}  — the new auto trigger per node.
    Nodes not present in new_auto have their auto trigger deleted (became
    ambiguous with no valid suffix — should not normally happen).
    This op is called by the trigger engine after any create/rename/delete.
    """
    new_auto: Dict[int, str]

    def apply(self, conn: sqlite3.Connection) -> None:
        ts = _now()
        # Remove all existing auto triggers.
        conn.execute("DELETE FROM triggers WHERE is_auto = 1")
        # Insert new ones. Conflicts with custom triggers are an error —
        # the trigger engine must check for collisions before calling this op.
        for node_id, text in self.new_auto.items():
            conn.execute(
                "INSERT INTO triggers (node_id, trigger_text, is_auto, created_at) VALUES (?, ?, 1, ?)",
                (node_id, text, ts),
            )


# ---------------------------------------------------------------------------
# Write ops — Common formats / delimiters
# ---------------------------------------------------------------------------

@dataclass
class UpsertCommonFormatOp:
    format: str

    def apply(self, conn: sqlite3.Connection) -> None:
        ts = _now()
        conn.execute(
            """
            INSERT INTO common_formats (format, use_count, created_at)
            VALUES (?, 1, ?)
            ON CONFLICT(format) DO UPDATE SET use_count = use_count + 1
            """,
            (self.format, ts),
        )


@dataclass
class UpsertCommonDelimiterOp:
    delimiter: str

    def apply(self, conn: sqlite3.Connection) -> None:
        ts = _now()
        conn.execute(
            """
            INSERT INTO common_delimiters (delimiter, use_count, is_builtin, created_at)
            VALUES (?, 1, 0, ?)
            ON CONFLICT(delimiter) DO UPDATE SET use_count = use_count + 1
            """,
            (self.delimiter, ts),
        )


@dataclass
class CreateTemplateSlotOp:
    folder_node_id: int
    sub_name_template: str
    order_index: int = 0

    def apply(self, conn: sqlite3.Connection) -> int:
        ts = _now()
        cur = conn.execute(
            "INSERT INTO template_slots (folder_node_id, sub_name_template, order_index, created_at)"
            " VALUES (?, ?, ?, ?)",
            (self.folder_node_id, self.sub_name_template, self.order_index, ts),
        )
        return cur.lastrowid


@dataclass
class UpdateTemplateSlotOp:
    slot_id: int
    sub_name_template: Optional[str] = None
    order_index: Optional[int] = None

    def apply(self, conn: sqlite3.Connection) -> None:
        if self.sub_name_template is not None:
            conn.execute(
                "UPDATE template_slots SET sub_name_template = ? WHERE id = ?",
                (self.sub_name_template, self.slot_id),
            )
        if self.order_index is not None:
            conn.execute(
                "UPDATE template_slots SET order_index = ? WHERE id = ?",
                (self.order_index, self.slot_id),
            )


@dataclass
class DeleteTemplateSlotOp:
    slot_id: int

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM template_slots WHERE id = ?", (self.slot_id,))


@dataclass
class CreateTemplatePromptOp:
    slot_id: int
    content: str
    weight: float = 1.0
    enabled: bool = True
    order_index: int = 0

    def apply(self, conn: sqlite3.Connection) -> int:
        ts = _now()
        cur = conn.execute(
            "INSERT INTO template_prompts"
            " (template_slot_id, content, weight, enabled, order_index, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (self.slot_id, self.content, self.weight, int(self.enabled), self.order_index, ts),
        )
        return cur.lastrowid


@dataclass
class UpdateTemplatePromptOp:
    prompt_id: int
    content: Optional[str] = None
    weight: Optional[float] = None
    enabled: Optional[bool] = None
    order_index: Optional[int] = None

    def apply(self, conn: sqlite3.Connection) -> None:
        fields, params = [], []
        if self.content   is not None: fields.append("content = ?");     params.append(self.content)
        if self.weight    is not None: fields.append("weight = ?");      params.append(self.weight)
        if self.enabled   is not None: fields.append("enabled = ?");     params.append(int(self.enabled))
        if self.order_index is not None: fields.append("order_index = ?"); params.append(self.order_index)
        if not fields:
            return
        params.append(self.prompt_id)
        conn.execute(f"UPDATE template_prompts SET {', '.join(fields)} WHERE id = ?", params)


@dataclass
class DeleteTemplatePromptOp:
    prompt_id: int

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM template_prompts WHERE id = ?", (self.prompt_id,))


# ---------------------------------------------------------------------------
# Read APIs
# ---------------------------------------------------------------------------

def get_prompt(prompt_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single prompt by id. Returns None if not found."""
    conn = _db.connect_read(_db_path())
    try:
        row = conn.execute(
            "SELECT * FROM prompts WHERE id = ?", (prompt_id,)
        ).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        conn.close()


def get_node(node_id: int) -> Optional[Dict[str, Any]]:
    """Fetch a single node by id. Returns None if not found.

    Includes auto_trigger from the triggers table (NULL for folders).
    """
    conn = _db.connect_read(_db_path())
    try:
        row = conn.execute(
            """
            SELECT n.*, t.trigger_text AS auto_trigger
            FROM nodes n
            LEFT JOIN triggers t ON t.node_id = n.id AND t.is_auto = 1
            WHERE n.id = ?
            """, (node_id,)
        ).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        conn.close()


def get_node_by_path(full_path: str) -> Optional[Dict[str, Any]]:
    """Fetch a single node by its full dot-path. Returns None if not found."""
    conn = _db.connect_read(_db_path())
    try:
        row = conn.execute(
            "SELECT * FROM nodes WHERE full_path = ?", (full_path,)
        ).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        conn.close()


def get_children(parent_id: Optional[int]) -> List[Dict[str, Any]]:
    """Return direct children of a parent node, ordered by order_index then name."""
    conn = _db.connect_read(_db_path())
    try:
        if parent_id is None:
            rows = conn.execute(
                "SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY order_index, name"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM nodes WHERE parent_id = ? ORDER BY order_index, name",
                (parent_id,),
            ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_subtree_paths(root_full_path: str) -> List[str]:
    """Return full_path for the root node and all its descendants."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            """
            SELECT full_path FROM nodes
            WHERE full_path = ? OR full_path LIKE ?
            ORDER BY full_path
            """,
            (root_full_path, root_full_path + ".%"),
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        conn.close()


def get_tree() -> List[Dict[str, Any]]:
    """Return ALL nodes ordered by full_path (caller builds tree structure).

    Each row includes an ``auto_trigger`` column (the node's single is_auto=1
    trigger text, or None for folders / entries without one).
    """
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            """
            SELECT n.*, t.trigger_text AS auto_trigger
            FROM nodes n
            LEFT JOIN triggers t ON t.node_id = n.id AND t.is_auto = 1
            ORDER BY n.full_path
            """
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_prompts(node_id: int) -> List[Dict[str, Any]]:
    """Return prompts for a node: enabled first (by order_index), then disabled (alpha)."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            """
            SELECT * FROM prompts
            WHERE node_id = ?
            ORDER BY
                enabled DESC,
                CASE WHEN enabled = 1 THEN order_index ELSE NULL END ASC,
                CASE WHEN enabled = 0 THEN content    ELSE NULL END ASC
            """,
            (node_id,),
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_triggers(node_id: int) -> List[Dict[str, Any]]:
    """Return all triggers for a node (auto + custom)."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM triggers WHERE node_id = ? ORDER BY is_auto DESC, trigger_text",
            (node_id,),
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_all_triggers() -> List[Dict[str, Any]]:
    """Return every trigger in the library. Used by the trigger engine and lookup."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM triggers ORDER BY trigger_text"
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def search_prompt_contents(q: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Autocomplete: distinct enabled prompt contents matching q (substring).

    Each result carries one source entry (name + full_path) for display. Used as a
    library autocomplete source alongside danbooru tags.
    """
    q = (q or "").strip()
    if not q:
        return []
    pattern = f"%{q}%"
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            """
            SELECT p.content AS content,
                   MIN(n.name) AS entry_name,
                   MIN(n.full_path) AS full_path,
                   COUNT(*) AS uses
            FROM prompts p
            JOIN nodes n ON n.id = p.node_id
            WHERE p.enabled = 1 AND p.content LIKE ?
              AND NOT (p.content LIKE '[%' AND p.content LIKE '%]'
                       AND p.content NOT LIKE '%,%'
                       AND p.content NOT LIKE '%{%'
                       AND p.content NOT LIKE '%|%'
                       AND p.content NOT LIKE '%' || char(10) || '%')
            GROUP BY p.content
            ORDER BY uses DESC, LENGTH(p.content) ASC
            LIMIT ?
            """,
            (pattern, limit),
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def search_refs(q: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Autocomplete for [entry]/​/entry refs: matching entry full_paths + triggers.

    Returns dicts: {name, kind: 'entry'|'trigger', definition} where `definition`
    is the owning entry's full_path (req 171: trigger suggestions show their entry).
    """
    q = (q or "").strip()
    pattern = f"%{q}%"
    conn = _db.connect_read(_db_path())
    try:
        out: List[Dict[str, Any]] = []
        for r in conn.execute(
            "SELECT n.id, n.name, n.full_path, "
            "(SELECT t.trigger_text FROM triggers t WHERE t.node_id = n.id AND t.is_auto = 1 LIMIT 1) AS auto_trigger "
            "FROM nodes n WHERE n.has_prompts = 1 "
            "AND (n.full_path LIKE ? OR n.name LIKE ?) ORDER BY n.full_path LIMIT ?",
            (pattern, pattern, limit),
        ).fetchall():
            out.append({"name": r["full_path"], "kind": "entry", "definition": r["name"], "id": r["id"], "auto_trigger": r["auto_trigger"]})
        for r in conn.execute(
            "SELECT t.trigger_text AS trigger_text, n.full_path AS full_path, n.id AS node_id "
            "FROM triggers t JOIN nodes n ON n.id = t.node_id "
            "WHERE t.trigger_text LIKE ? ORDER BY t.trigger_text LIMIT ?",
            (pattern, limit),
        ).fetchall():
            out.append({"name": r["trigger_text"], "kind": "trigger", "definition": r["full_path"], "id": r["node_id"]})
        return out[:limit]
    finally:
        conn.close()


def search_entries_by_prompt(q: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Return distinct entries whose enabled prompts contain q (substring).

    Returns dicts: {id, name, full_path, pos_neg, delimiter, auto_trigger}.
    """
    q = (q or "").strip()
    if not q:
        return []
    pattern = f"%{q}%"
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT n.id, n.name, n.full_path, n.pos_neg, n.delimiter
            FROM nodes n
            JOIN prompts p ON p.node_id = n.id
            WHERE n.has_prompts = 1 AND p.enabled = 1 AND p.content LIKE ?
            ORDER BY n.full_path
            LIMIT ?
            """,
            (pattern, limit),
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            trigger = conn.execute(
                "SELECT trigger_text FROM triggers WHERE node_id=? AND is_auto=1 LIMIT 1",
                (r["id"],),
            ).fetchone()
            out.append({
                "id": r["id"],
                "name": r["name"],
                "full_path": r["full_path"],
                "pos_neg": r["pos_neg"],
                "delimiter": r["delimiter"],
                "auto_trigger": trigger["trigger_text"] if trigger else None,
            })
        return out
    finally:
        conn.close()


def get_template_slots(folder_id: int) -> List[Dict[str, Any]]:
    """Return template slots for a folder node, ordered by order_index."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM template_slots WHERE folder_node_id = ? ORDER BY order_index",
            (folder_id,),
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_template_slot_prompts(slot_id: int) -> List[Dict[str, Any]]:
    """Return default prompts for a template slot, ordered by order_index."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM template_prompts WHERE template_slot_id = ? ORDER BY order_index",
            (slot_id,),
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_common_formats() -> List[Dict[str, Any]]:
    """Return all common formats, most-used first."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM common_formats ORDER BY use_count DESC, format"
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def get_common_delimiters() -> List[Dict[str, Any]]:
    """Return all delimiters: built-ins first, then user-defined by use_count."""
    conn = _db.connect_read(_db_path())
    try:
        rows = conn.execute(
            "SELECT * FROM common_delimiters ORDER BY is_builtin DESC, use_count DESC, delimiter"
        ).fetchall()
        return _rows_to_list(rows)
    finally:
        conn.close()


def replace_refs_in_prompts(replacements: List[Dict[str, str]]) -> int:
    """Replace old [ref] patterns with new ones in all prompt contents.

    Each entry in `replacements` must have ``old`` and ``new`` keys. The function
    replaces ``[old]`` and ``[old.`` (prefix for sub-entry refs) with
    ``[new]`` / ``[new.`` across every row in the ``prompts`` table. Returns the
    total number of rows updated.
    """
    if not replacements:
        return 0
    conn = _db.connect_write(_db_path())
    total = 0
    try:
        with conn:
            for r in replacements:
                old = str(r["old"])
                new = str(r["new"])
                if old == new:
                    continue
                old_b = f"[{old}]"
                new_b = f"[{new}]"
                old_d = f"[{old}."
                new_d = f"[{new}."
                # Replace prefix first to keep them disjoint
                res = conn.execute(
                    "UPDATE prompts SET content = REPLACE(REPLACE(content, ?, ?), ?, ?), updated_at = ? "
                    "WHERE content LIKE ? OR content LIKE ?",
                    (old_d, new_d, old_b, new_b, _now(), f"%[{old}]%", f"%[{old}.%"),
                )
                total += res.rowcount
    finally:
        conn.close()
    return total


def find_usages(node_id: int) -> Dict[str, Any]:
    """Find all references to a node (and its subtree entries) in other entries' prompts.

    Returns {entries: [{id, name, full_path, triggers: [str], refs: [str]}],
             usages: [{prompt_id, content_snippet, entry_name, entry_full_path, matched_ref}]}
    Only includes usages from *other* nodes (not the subtree itself).
    """
    conn = _db.connect_read(_db_path())
    try:
        node = conn.execute("SELECT id, name, full_path, has_prompts FROM nodes WHERE id = ?", (node_id,)).fetchone()
        if not node:
            return {"entries": [], "usages": []}

        # Gather all entries in the subtree
        root_path = node["full_path"]
        subtree_rows = conn.execute(
            "SELECT id, name, full_path, has_prompts FROM nodes WHERE full_path = ? OR full_path LIKE ? ORDER BY full_path",
            (root_path, root_path + ".%"),
        ).fetchall()

        subtree_ids = {r["id"] for r in subtree_rows}
        entry_rows = [r for r in subtree_rows if r["has_prompts"]]
        if not entry_rows:
            return {"entries": [], "usages": []}

        # Gather triggers for each entry
        trigger_map = {}
        all_refs = []
        for e in entry_rows:
            triggers = conn.execute(
                "SELECT trigger_text, is_auto FROM triggers WHERE node_id = ?", (e["id"],)
            ).fetchall()
            trigger_texts = [t["trigger_text"] for t in triggers]
            trigger_map[e["id"]] = trigger_texts
            # Build all possible ref strings for this entry
            entry_refs = [e["full_path"]] + trigger_texts
            all_refs.extend(entry_refs)

        if not all_refs:
            return {"entries": [], "usages": []}

        # Build entries list for the response
        entries_out = [
            {
                "id": e["id"],
                "name": e["name"],
                "full_path": e["full_path"],
                "triggers": trigger_map.get(e["id"], []),
                "refs": [e["full_path"]] + trigger_map.get(e["id"], []),
            }
            for e in entry_rows
        ]

        # Search prompts for references — exclude prompts belonging to the subtree
        import re
        escaped = [re.escape(r) for r in all_refs]
        ref_re = re.compile(r'\[(' + '|'.join(escaped) + r')(?:\.[^\]]+)?\]')

        prompt_rows = conn.execute(
            """
            SELECT p.id, p.content, p.node_id, n.name AS entry_name, n.full_path AS entry_full_path
            FROM prompts p
            JOIN nodes n ON n.id = p.node_id
            WHERE p.enabled = 1
            ORDER BY n.full_path, p.order_index
            """
        ).fetchall()

        usages_out = []
        for pr in prompt_rows:
            if pr["node_id"] in subtree_ids:
                continue  # skip own subtree
            matches = ref_re.findall(pr["content"])
            if not matches:
                continue
            for m in set(matches):
                snippet = pr["content"]
                if len(snippet) > 100:
                    idx = snippet.find(f"[{m}")
                    start = max(0, (idx if idx >= 0 else 0) - 30)
                    snippet = ("…" if start > 0 else "") + snippet[start:start + 100] + ("…" if start + 100 < len(pr["content"]) else "")
                usages_out.append({
                    "prompt_id": pr["id"],
                    "content_snippet": snippet,
                    "entry_name": pr["entry_name"],
                    "entry_full_path": pr["entry_full_path"],
                    "matched_ref": m,
                })

        return {"entries": entries_out, "usages": usages_out}
    finally:
        conn.close()


def strip_refs(refs: List[str]) -> int:
    """Remove all references to the given ref strings from ALL prompts in the library.

    Uses Python regex to cleanly remove ``[ref]`` and ``[ref.sub_path]`` tokens.
    Returns the number of prompts updated.
    """
    if not refs:
        return 0
    import re
    conn = _db.connect_write(_db_path())
    total = 0
    try:
        escaped = [re.escape(r) for r in refs]
        ref_re = re.compile(r'\[(' + '|'.join(escaped) + r')(?:\.[^\]]+)?\]')

        with conn:
            patterns = []
            params = []
            for r in refs:
                patterns.append("(content LIKE ? OR content LIKE ?)")
                params.extend([f"%[{r}]%", f"%[{r}.%"])
            where = " OR ".join(patterns)

            rows = conn.execute(
                f"SELECT id, content FROM prompts WHERE enabled = 1 AND ({where})",
                params,
            ).fetchall()

            for row in rows:
                new_content = ref_re.sub('', row["content"])
                # Clean up: collapse consecutive delimiters, trim stray delimiters at ends
                new_content = re.sub(r',\s*,', ', ', new_content)
                new_content = re.sub(r'\|\s*\|', '|', new_content)
                new_content = re.sub(r'^\s*[,|]\s*', '', new_content)
                new_content = re.sub(r'\s*[,|]\s*$', '', new_content)
                new_content = new_content.strip()
                if new_content != row["content"]:
                    conn.execute(
                        "UPDATE prompts SET content = ?, updated_at = ? WHERE id = ?",
                        (new_content, _now(), row["id"]),
                    )
                    total += 1
    finally:
        conn.close()
    return total
