"""XYZ Image Gallery — repository (T04 write side + T09 read side).

Scope:
  * **Write side (T04)**: ``WriteQueue`` priority queue + single-writer
    daemon thread; every op is wrapped in its *own*
    ``BEGIN / op.apply(conn) / COMMIT`` transaction (**not** the
    drain-64 / SAVEPOINT batch model that an earlier revision of
    ARCHITECTURE §4.6 described — explicitly superseded by T04's
    UPDATED spec to guarantee that a failing op never partially-commits
    alongside its neighbours).  ``enqueue_write(priority, op) -> Future``
    is the sole public write API.
  * **Op classes**: ``UpsertImageOp`` (T07), ``EnsureFolderOp`` (T05),
    ``InsertThumbCacheOp`` (T08), ``SetSyncStatusOp`` / ``SetSyncFailedOp`` /
    ``SetSyncHardFailedOp`` (T17), ``DeleteImageOp`` (T20+), placeholder
    ``UpdateImagePathOp`` (T24 bulk / single move path update).
  * **Read side (T09)**: ``get_image`` / ``list_images`` (cursor-paged,
    filtered) / ``folder_tree`` / ``neighbors``.  All read APIs open a
    short-lived ``db.connect_read`` connection (WAL → multi-reader);
    they never touch the WriteQueue.

Out of scope (deferred):
  * ``UpdateImagePathOp`` (bulk path update)         — T24 (implemented)
  * FTS5 ``image_fts`` + search queries             — T28
"""

from __future__ import annotations

import base64
import itertools
import json
import logging
import os
import queue
import sqlite3
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from . import db as _db
from . import paths as _paths
from . import vocab as _vocab

logger = logging.getLogger("xyz.gallery.repo")

__all__ = [
    "HIGH",
    "MID",
    "LOW",
    "WriteQueue",
    "UpsertImageOp",
    "UpsertVocabAndLinksOp",
    "RebuildPromptVocabFullOp",
    "UpdateImageOp",
    "ResyncMetadataOp",
    "UpdateImagePathOp",
    "DeleteImageOp",
    "UnindexCustomRootOp",
    "RelocateFolderSubtreeDbOp",
    "PurgeFolderSubtreeDbOp",
    "EnsureFolderOp",
    "ReconcileFoldersUnderRootOp",
    "InsertThumbCacheOp",
    "SetSyncStatusOp",
    "SetSyncFailedOp",
    "SetSyncHardFailedOp",
    # T09 read-side DTOs + API
    "FilterSpec",
    "SortSpec",
    "ImageRecord",
    "FolderNode",
    "ListPage",
    "Neighbors",
    "DEFAULT_PAGE_SIZE",
    "MAX_PAGE_SIZE",
    "TOTAL_ESTIMATE_CAP",
    "get_image",
    "list_images",
    "folder_tree",
    "neighbors",
    # T21 vocab read helpers
    "vocab_lookup",
    "list_models_for_vocab",
    "model_vocab_label",
    "VOCAB_LOOKUP_DEFAULT_LIMIT",
    "VOCAB_LOOKUP_MAX_LIMIT",
    "SelectionSpec",
    "count_selection",
    "list_selection_ids_preview",
    "fetch_selection_id_paths",
    "fetch_selection_id_path_tags_csv",
    "fetch_selection_move_sources",
    "list_tags_admin",
    "DeleteTagByNameOp",
    "PurgeZeroUsageTagsOp",
    "RenameTagOp",
    # T33 folder HTTP helpers
    "fetch_folder_row",
    "fetch_folder_with_root",
]


HIGH: int = 0
MID: int = 1
LOW: int = 2

_VALID_PRIORITIES = frozenset((HIGH, MID, LOW))

# Starvation guard: after this many consecutive LOW ops, if any HIGH/MID is
# waiting, defer the current LOW. In the one-op-per-tx model PriorityQueue
# already preempts on every get(); this is a belt-and-suspenders check
# mandated by TASKS.md T04.
_LOW_YIELD_THRESHOLD: int = 200

# Writer-crash restart backoff: keep it well under the 200 ms stop budget
# (TASKS.md T04 test #4) so a single crash can't blow the join deadline.
_CRASH_RESTART_SLEEP_SEC: float = 0.02

_PathLike = Union[str, Path]


# -- Placeholder op factories ----------------------------------------------
#
# T04 intentionally ships these as empty shells: the WriteQueue contract is
# "anything with a .apply(conn) method can be enqueued". Concrete fields and
# SQL are added by the owning downstream task. Do NOT widen these here.

class UpsertImageOp:
    """Upsert one ``image`` row (T07 cold-scan / delta-scan / index_one).

    Fields mirror the ``image`` columns populated at index time (SPEC §6.1).
    ``content_hash`` is intentionally left NULL — SPEC marks it as
    "computed lazily" and T07 does not compute it (AI_RULES R1.2 / R4.3).

    ``favorite`` / ``tags_csv`` come from the PNG's ``xyz_gallery.*`` mirror
    chunks (if present).  On conflict we ``COALESCE`` these two columns so
    that re-indexing a PNG that no longer carries the mirror does NOT wipe
    a value the DB already holds (DB is the source of truth — C-1).

    Folder-chain maintenance also lives here: before the image row itself,
    ``apply()`` walks ``root → ... → immediate dir`` and ``INSERT OR IGNORE``s
    each level into ``folder`` (``parent_id`` chained).  The per-op
    transaction guarantees image + sub-folder rows land atomically.
    Reusing the shared op-per-transaction envelope keeps the invariant
    from PROJECT_STATE §4 #15 intact (no writes outside the queue).
    """

    def __init__(self, *,
                 path: str,
                 folder_id: int,
                 root_path: str,
                 root_kind: str,
                 relative_path: str,
                 filename: str,
                 filename_lc: str,
                 ext: str,
                 width: Optional[int],
                 height: Optional[int],
                 file_size: int,
                 mtime_ns: int,
                 created_at: int,
                 positive_prompt: Optional[str],
                 negative_prompt: Optional[str],
                 model: Optional[str],
                 seed: Optional[int],
                 cfg: Optional[float],
                 sampler: Optional[str],
                 scheduler: Optional[str],
                 workflow_present: int,
                 favorite: Optional[int],
                 tags_csv: Optional[str],
                 indexed_at: int,
                 prompt_tokens: Optional[List[str]] = None,
                 word_tokens: Optional[List[str]] = None,
                 normalized_tags: Optional[List[str]] = None):
        self.path = path
        self.folder_id = folder_id
        self.root_path = root_path
        self.root_kind = root_kind
        self.relative_path = relative_path
        self.filename = filename
        self.filename_lc = filename_lc
        self.ext = ext
        self.width = width
        self.height = height
        self.file_size = int(file_size)
        self.mtime_ns = int(mtime_ns)
        self.created_at = int(created_at)
        self.positive_prompt = positive_prompt
        self.negative_prompt = negative_prompt
        self.model = model
        self.seed = seed
        self.cfg = cfg
        self.sampler = sampler
        self.scheduler = scheduler
        self.workflow_present = int(workflow_present)
        self.favorite = favorite
        self.tags_csv = tags_csv
        self.indexed_at = int(indexed_at)
        self.prompt_tokens = list(prompt_tokens) if prompt_tokens else []
        self.word_tokens = list(word_tokens) if word_tokens else []
        self.normalized_tags = list(normalized_tags) if normalized_tags else []

    def apply(self, conn: sqlite3.Connection) -> None:
        self._ensure_folder_chain(conn)
        conn.execute(_UPSERT_IMAGE_SQL, {
            "path": self.path,
            "folder_id": self.folder_id,
            "relative_path": self.relative_path,
            "filename": self.filename,
            "filename_lc": self.filename_lc,
            "ext": self.ext,
            "width": self.width,
            "height": self.height,
            "file_size": self.file_size,
            "mtime_ns": self.mtime_ns,
            "created_at": self.created_at,
            "positive_prompt": self.positive_prompt,
            "negative_prompt": self.negative_prompt,
            "model": self.model,
            "seed": self.seed,
            "cfg": self.cfg,
            "sampler": self.sampler,
            "scheduler": self.scheduler,
            "workflow_present": self.workflow_present,
            "favorite": self.favorite,
            "tags_csv": self.tags_csv,
            "indexed_at": self.indexed_at,
        })
        row = conn.execute(
            "SELECT id, tags_csv FROM image WHERE path = ?",
            (self.path,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"upsert left no row for path={self.path!r}")
        image_id = int(row[0])
        # ``connect_write`` may leave row_factory unset → tuple row; use indices.
        tags_raw = row[1]
        # Must match the *stored* image.tags_csv, not ``self.normalized_tags`` from the
        # PNG re-read. ``ON CONFLICT`` uses COALESCE(excluded.tags_csv, image.tags_csv);
        # when the file has no xyz_gallery tag mirror yet, the row keeps DB tags but an
        # empty ``normalized_tags`` list would wrongly clear ``image_tag`` (usage drift).
        final_tag_names = _vocab.normalized_tag_list_from_csv(
            str(tags_raw) if tags_raw is not None else None,
        )
        UpsertVocabAndLinksOp(
            image_id=image_id,
            prompt_tokens=self.prompt_tokens,
            word_tokens=self.word_tokens,
            tag_names=final_tag_names,
        ).apply(conn)

    def _ensure_folder_chain(self, conn: sqlite3.Connection) -> None:
        # relative_path is the POSIX path relative to root_path, including
        # the filename.  The folder chain is everything *above* the file.
        rel_dir = self.relative_path.rsplit("/", 1)[0] if "/" in self.relative_path else ""
        if not rel_dir:
            return
        parent_id: int = self.folder_id
        parent_path: str = self.root_path
        for part in rel_dir.split("/"):
            if not part:
                continue
            sub_path = parent_path + "/" + part if not parent_path.endswith("/") else parent_path + part
            conn.execute(
                "INSERT OR IGNORE INTO folder"
                "(path, kind, parent_id, display_name, removable) "
                "VALUES (?, ?, ?, ?, ?)",
                (sub_path, self.root_kind, parent_id, part, 0),
            )
            row = conn.execute(
                "SELECT id FROM folder WHERE path = ?", (sub_path,)
            ).fetchone()
            if row is None:
                # Extremely unlikely — INSERT OR IGNORE above is inside the
                # same tx, so the row must be visible to this SELECT.
                # Bail out rather than silently stranding the image.
                raise RuntimeError(
                    f"folder row for {sub_path!r} vanished mid-transaction"
                )
            parent_id = int(row[0])
            parent_path = sub_path


# Stored at module level so the (somewhat long) SQL is built once per
# process rather than on every op.  When ``metadata_sync_status`` is not
# ``'ok'``, the DB holds user edits the on-disk file has not yet caught
# up to — keep ``favorite`` / ``tags_csv`` from the existing row so
# a re-index does not re-inject stale PNG values.  Otherwise, ``COALESCE`` on
# these columns protects re-indexing when the PNG *lacks* mirror chunks.
_UPSERT_IMAGE_SQL = """
INSERT INTO image (
    path, folder_id, relative_path, filename, filename_lc, ext,
    width, height, file_size, mtime_ns, created_at,
    positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler,
    workflow_present, favorite, tags_csv, indexed_at
) VALUES (
    :path, :folder_id, :relative_path, :filename, :filename_lc, :ext,
    :width, :height, :file_size, :mtime_ns, :created_at,
    :positive_prompt, :negative_prompt, :model, :seed, :cfg, :sampler, :scheduler,
    :workflow_present, :favorite, :tags_csv, :indexed_at
)
ON CONFLICT(path) DO UPDATE SET
    folder_id        = excluded.folder_id,
    relative_path    = excluded.relative_path,
    filename         = excluded.filename,
    filename_lc      = excluded.filename_lc,
    ext              = excluded.ext,
    width            = excluded.width,
    height           = excluded.height,
    file_size        = excluded.file_size,
    mtime_ns         = excluded.mtime_ns,
    created_at       = COALESCE(image.created_at, excluded.created_at),
    positive_prompt  = excluded.positive_prompt,
    negative_prompt  = excluded.negative_prompt,
    model            = excluded.model,
    seed             = excluded.seed,
    cfg              = excluded.cfg,
    sampler          = excluded.sampler,
    scheduler        = excluded.scheduler,
    workflow_present = excluded.workflow_present,
    favorite         = CASE
      WHEN image.metadata_sync_status IN ('pending', 'failed')
        THEN image.favorite
        ELSE COALESCE(excluded.favorite, image.favorite)
    END,
    tags_csv         = CASE
      WHEN image.metadata_sync_status IN ('pending', 'failed')
        THEN image.tags_csv
        ELSE COALESCE(excluded.tags_csv, image.tags_csv)
    END,
    indexed_at       = excluded.indexed_at
"""


class UpsertVocabAndLinksOp:
    """Replace ``image_prompt_token`` / ``image_tag`` rows for one image (T15).

    Runs in the same SQLite transaction as ``UpsertImageOp`` — never enqueue
    this alone while the image row is mid-upsert elsewhere.
    """

    def __init__(
        self,
        *,
        image_id: int,
        prompt_tokens: List[str],
        tag_names: List[str],
        word_tokens: Optional[List[str]] = None,
    ):
        self.image_id = int(image_id)
        self.prompt_tokens = list(prompt_tokens)
        self.word_tokens = list(word_tokens) if word_tokens else []
        self.tag_names = list(tag_names)

    def apply(self, conn: sqlite3.Connection) -> None:
        for (tid,) in conn.execute(
            "SELECT token_id FROM image_prompt_token WHERE image_id = ?",
            (self.image_id,),
        ).fetchall():
            conn.execute(
                "UPDATE prompt_token SET usage_count = usage_count - 1 "
                "WHERE id = ? AND usage_count > 0",
                (int(tid),),
            )
            conn.execute(
                "DELETE FROM prompt_token WHERE id = ? AND usage_count = 0",
                (int(tid),),
            )
        conn.execute(
            "DELETE FROM image_prompt_token WHERE image_id = ?",
            (self.image_id,),
        )

        for (wid,) in conn.execute(
            "SELECT token_id FROM image_word_token WHERE image_id = ?",
            (self.image_id,),
        ).fetchall():
            conn.execute(
                "UPDATE word_token SET usage_count = usage_count - 1 "
                "WHERE id = ? AND usage_count > 0",
                (int(wid),),
            )
            conn.execute(
                "DELETE FROM word_token WHERE id = ? AND usage_count = 0",
                (int(wid),),
            )
        conn.execute(
            "DELETE FROM image_word_token WHERE image_id = ?",
            (self.image_id,),
        )

        for (gid,) in conn.execute(
            "SELECT tag_id FROM image_tag WHERE image_id = ?",
            (self.image_id,),
        ).fetchall():
            conn.execute(
                "UPDATE tag SET usage_count = usage_count - 1 "
                "WHERE id = ? AND usage_count > 0",
                (int(gid),),
            )
        conn.execute("DELETE FROM image_tag WHERE image_id = ?", (self.image_id,))

        for tok in self.prompt_tokens:
            conn.execute(
                "INSERT OR IGNORE INTO prompt_token(token, usage_count) VALUES (?, 0)",
                (tok,),
            )
            row = conn.execute(
                "SELECT id FROM prompt_token WHERE token = ? COLLATE NOCASE",
                (tok,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"prompt_token missing after insert for {tok!r}")
            pid = int(row[0])
            conn.execute(
                "UPDATE prompt_token SET usage_count = usage_count + 1 WHERE id = ?",
                (pid,),
            )
            conn.execute(
                "INSERT INTO image_prompt_token(image_id, token_id) VALUES (?, ?)",
                (self.image_id, pid),
            )

        for wtok in self.word_tokens:
            conn.execute(
                "INSERT OR IGNORE INTO word_token(token, usage_count) VALUES (?, 0)",
                (wtok,),
            )
            roww = conn.execute(
                "SELECT id FROM word_token WHERE token = ? COLLATE NOCASE",
                (wtok,),
            ).fetchone()
            if roww is None:
                raise RuntimeError(f"word_token missing after insert for {wtok!r}")
            wid = int(roww[0])
            conn.execute(
                "UPDATE word_token SET usage_count = usage_count + 1 WHERE id = ?",
                (wid,),
            )
            conn.execute(
                "INSERT INTO image_word_token(image_id, token_id) VALUES (?, ?)",
                (self.image_id, wid),
            )

        for name in self.tag_names:
            conn.execute(
                "INSERT OR IGNORE INTO tag(name, usage_count) VALUES (?, 0)",
                (name,),
            )
            row = conn.execute(
                "SELECT id FROM tag WHERE name = ? COLLATE NOCASE",
                (name,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"tag missing after insert for {name!r}")
            tid = int(row[0])
            conn.execute(
                "UPDATE tag SET usage_count = usage_count + 1 WHERE id = ?",
                (tid,),
            )
            conn.execute(
                "INSERT INTO image_tag(image_id, tag_id) VALUES (?, ?)",
                (self.image_id, tid),
            )


class RebuildPromptVocabFullOp:
    """T30 / §11: drop ``prompt_token`` / ``image_prompt_token`` and
    ``word_token`` / ``image_word_token``, then rebuild from
    ``image.positive_prompt`` (pipeline tokens + §11 F04 word lexemes).
    Tags unchanged. Runs as a single writer transaction.
    """

    def __init__(self, *, extra_stopwords: frozenset):
        self.extra_stopwords = extra_stopwords

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM image_prompt_token")
        conn.execute("DELETE FROM prompt_token")
        conn.execute("DELETE FROM image_word_token")
        conn.execute("DELETE FROM word_token")
        for row in conn.execute(
            "SELECT id, positive_prompt FROM image ORDER BY id",
        ):
            image_id = int(row[0])
            pos = row[1]
            tokens = _vocab.normalize_prompt(
                None if pos is None else str(pos),
                self.extra_stopwords,
            )
            for tok in tokens:
                conn.execute(
                    "INSERT OR IGNORE INTO prompt_token(token, usage_count) "
                    "VALUES (?, 0)",
                    (tok,),
                )
                pr = conn.execute(
                    "SELECT id FROM prompt_token WHERE token = ? COLLATE NOCASE",
                    (tok,),
                ).fetchone()
                if pr is None:
                    raise RuntimeError(
                        f"prompt_token missing after insert for {tok!r}",
                    )
                pid = int(pr[0])
                conn.execute(
                    "UPDATE prompt_token SET usage_count = usage_count + 1 "
                    "WHERE id = ?",
                    (pid,),
                )
                conn.execute(
                    "INSERT INTO image_prompt_token(image_id, token_id) "
                    "VALUES (?, ?)",
                    (image_id, pid),
                )
            for wtok in _vocab.split_positive_prompt_words(
                None if pos is None else str(pos),
            ):
                conn.execute(
                    "INSERT OR IGNORE INTO word_token(token, usage_count) "
                    "VALUES (?, 0)",
                    (wtok,),
                )
                wr = conn.execute(
                    "SELECT id FROM word_token WHERE token = ? COLLATE NOCASE",
                    (wtok,),
                ).fetchone()
                if wr is None:
                    raise RuntimeError(
                        f"word_token missing after insert for {wtok!r}",
                    )
                wid = int(wr[0])
                conn.execute(
                    "UPDATE word_token SET usage_count = usage_count + 1 "
                    "WHERE id = ?",
                    (wid,),
                )
                conn.execute(
                    "INSERT INTO image_word_token(image_id, token_id) "
                    "VALUES (?, ?)",
                    (image_id, wid),
                )


class UpdateImageOp:
    """PATCH user fields on one ``image`` row + bump ``version`` (T19).

    ``favorite`` / ``normalized_tags`` use ``None`` to mean "leave column
    unchanged".  An empty ``normalized_tags`` list clears ``tags_csv`` and
    all ``image_tag`` links (prompt-token and word-token links are preserved).

    ``apply`` returns the new ``version`` after a successful
    ``RETURNING`` (WriteQueue propagates this via ``Future.set_result``).
    """

    def __init__(
        self,
        *,
        image_id: int,
        favorite: Optional[int] = None,
        normalized_tags: Optional[List[str]] = None,
        bump_version: bool = True,
        refresh_sync: bool = True,
    ):
        self.image_id = int(image_id)
        self.favorite = favorite
        self.normalized_tags = normalized_tags
        self.bump_version = bool(bump_version)
        self.refresh_sync = bool(refresh_sync)

    def apply(self, conn: sqlite3.Connection) -> int:
        row = conn.execute(
            "SELECT id FROM image WHERE id = ?", (self.image_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"image id={self.image_id} not found")

        prompt_tokens: List[str] = []
        word_tokens: List[str] = []
        if self.normalized_tags is not None:
            for (tok,) in conn.execute(
                "SELECT prompt_token.token FROM image_prompt_token ipt "
                "INNER JOIN prompt_token ON prompt_token.id = ipt.token_id "
                "WHERE ipt.image_id = ? ORDER BY ipt.rowid",
                (self.image_id,),
            ).fetchall():
                prompt_tokens.append(str(tok))
            for (wtok,) in conn.execute(
                "SELECT word_token.token FROM image_word_token iwt "
                "INNER JOIN word_token ON word_token.id = iwt.token_id "
                "WHERE iwt.image_id = ? ORDER BY iwt.rowid",
                (self.image_id,),
            ).fetchall():
                word_tokens.append(str(wtok))

        sets: List[str] = []
        params: List[Any] = []

        if self.favorite is not None:
            sets.append("favorite = ?")
            params.append(int(self.favorite))

        if self.normalized_tags is not None:
            if self.normalized_tags:
                tags_csv = ",".join(self.normalized_tags)
            else:
                tags_csv = None
            sets.append("tags_csv = ?")
            params.append(tags_csv)

        if self.refresh_sync:
            sets.extend(
                (
                    "metadata_sync_status = 'pending'",
                    "metadata_sync_retry_count = 0",
                    "metadata_sync_next_retry_at = NULL",
                    "metadata_sync_last_error = NULL",
                )
            )

        if self.bump_version:
            sets.append("version = version + 1")

        if not sets:
            raise ValueError("UpdateImageOp: nothing to update")

        sql = "UPDATE image SET " + ", ".join(sets) + " WHERE id = ? RETURNING version"
        params.append(self.image_id)
        out = conn.execute(sql, params).fetchone()
        if out is None:
            raise RuntimeError(f"UPDATE image id={self.image_id} missed RETURNING")
        new_version = int(out[0])

        if self.normalized_tags is not None:
            UpsertVocabAndLinksOp(
                image_id=self.image_id,
                prompt_tokens=prompt_tokens,
                word_tokens=word_tokens,
                tag_names=list(self.normalized_tags),
            ).apply(conn)

        return new_version


class ResyncMetadataOp:
    """Reset PNG sync retry state without bumping ``version`` (T19 /resync)."""

    def __init__(self, *, image_id: int):
        self.image_id = int(image_id)

    def apply(self, conn: sqlite3.Connection) -> int:
        row = conn.execute(
            "UPDATE image SET "
            "metadata_sync_status = 'pending', "
            "metadata_sync_retry_count = 0, "
            "metadata_sync_next_retry_at = NULL, "
            "metadata_sync_last_error = NULL "
            "WHERE id = ? RETURNING version",
            (self.image_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"image id={self.image_id} not found")
        return int(row[0])


class UpdateImagePathOp:
    """Rewrite ``path`` / folder columns after a successful on-disk move (T24).

    ``refresh_sync``: when ``True`` (legacy default for direct op use in tests),
    reset ``metadata_sync_*`` to ``pending`` so :mod:`metadata_sync` rewrites
    PNG ``xyz_gallery.*`` chunks. Bulk / single **service** moves pass ``False``:
    the file is only relocated on disk — bytes and mirror chunks are unchanged
    relative to DB — so a full PNG round-trip is redundant.
    """

    def __init__(
        self,
        *,
        image_id: int,
        path: str,
        folder_id: int,
        relative_path: str,
        filename: str,
        filename_lc: str,
        ext: str,
        file_size: int,
        mtime_ns: int,
        refresh_sync: bool = True,
    ):
        self.image_id = int(image_id)
        self.path = str(path)
        self.folder_id = int(folder_id)
        self.relative_path = str(relative_path)
        self.filename = str(filename)
        self.filename_lc = str(filename_lc)
        self.ext = str(ext)
        self.file_size = int(file_size)
        self.mtime_ns = int(mtime_ns)
        self.refresh_sync = bool(refresh_sync)

    def apply(self, conn: sqlite3.Connection) -> int:
        row = conn.execute(
            "SELECT id FROM image WHERE id = ?", (self.image_id,)
        ).fetchone()
        if row is None:
            raise KeyError(f"image id={self.image_id} not found")
        sets = [
            "path = ?",
            "folder_id = ?",
            "relative_path = ?",
            "filename = ?",
            "filename_lc = ?",
            "ext = ?",
            "file_size = ?",
            "mtime_ns = ?",
            "version = version + 1",
        ]
        params: List[Any] = [
            self.path,
            self.folder_id,
            self.relative_path,
            self.filename,
            self.filename_lc,
            self.ext,
            self.file_size,
            self.mtime_ns,
        ]
        if self.refresh_sync:
            sets.extend(
                (
                    "metadata_sync_status = 'pending'",
                    "metadata_sync_retry_count = 0",
                    "metadata_sync_next_retry_at = NULL",
                    "metadata_sync_last_error = NULL",
                )
            )
        sql = "UPDATE image SET " + ", ".join(sets) + " WHERE id = ? RETURNING version"
        params.append(self.image_id)
        out = conn.execute(sql, params).fetchone()
        if out is None:
            raise RuntimeError(f"UPDATE image path id={self.image_id} missed RETURNING")
        return int(out[0])


def _delete_image_row_by_id(conn: sqlite3.Connection, image_id: int) -> None:
    """Cascade-delete one ``image`` row by primary key (DB only)."""
    for (tid,) in conn.execute(
        "SELECT token_id FROM image_prompt_token WHERE image_id = ?",
        (image_id,),
    ).fetchall():
        conn.execute(
            "UPDATE prompt_token SET usage_count = usage_count - 1 "
            "WHERE id = ? AND usage_count > 0",
            (int(tid),),
        )
        conn.execute(
            "DELETE FROM prompt_token WHERE id = ? AND usage_count = 0",
            (int(tid),),
        )
    conn.execute(
        "DELETE FROM image_prompt_token WHERE image_id = ?",
        (image_id,),
    )
    for (wid,) in conn.execute(
        "SELECT token_id FROM image_word_token WHERE image_id = ?",
        (image_id,),
    ).fetchall():
        conn.execute(
            "UPDATE word_token SET usage_count = usage_count - 1 "
            "WHERE id = ? AND usage_count > 0",
            (int(wid),),
        )
        conn.execute(
            "DELETE FROM word_token WHERE id = ? AND usage_count = 0",
            (int(wid),),
        )
    conn.execute(
        "DELETE FROM image_word_token WHERE image_id = ?",
        (image_id,),
    )
    for (gid,) in conn.execute(
        "SELECT tag_id FROM image_tag WHERE image_id = ?",
        (image_id,),
    ).fetchall():
        conn.execute(
            "UPDATE tag SET usage_count = usage_count - 1 "
            "WHERE id = ? AND usage_count > 0",
            (int(gid),),
        )
    conn.execute("DELETE FROM image_tag WHERE image_id = ?", (image_id,))
    conn.execute("DELETE FROM thumbnail_cache WHERE image_id = ?", (image_id,))
    conn.execute("DELETE FROM image WHERE id = ?", (image_id,))


def _rebuild_tags_csv_for_image(conn: sqlite3.Connection, image_id: int) -> int:
    """Rewrite ``image.tags_csv`` from ``image_tag`` + bump ``version`` (T36 tag admin)."""
    rows = conn.execute(
        "SELECT t.name FROM image_tag it "
        "INNER JOIN tag t ON t.id = it.tag_id "
        "WHERE it.image_id = ? ORDER BY lower(t.name)",
        (int(image_id),),
    ).fetchall()
    names = [str(r[0]) for r in rows]
    tags_csv = ",".join(names) if names else None
    row = conn.execute(
        "UPDATE image SET tags_csv = ?, version = version + 1, "
        "metadata_sync_status = 'pending', metadata_sync_retry_count = 0, "
        "metadata_sync_next_retry_at = NULL, metadata_sync_last_error = NULL "
        "WHERE id = ? RETURNING version",
        (tags_csv, int(image_id)),
    ).fetchone()
    if row is None:
        raise KeyError(f"image id={image_id} not found")
    return int(row[0])


class DeleteTagByNameOp:
    """Remove a ``tag`` row (CASCADE ``image_tag``) and refresh ``tags_csv``."""

    def __init__(self, *, name: str):
        self.name = str(name or "").strip()

    def apply(self, conn: sqlite3.Connection) -> Dict[str, Any]:
        norm = _vocab.normalize_tag(self.name)
        if not norm:
            raise ValueError("tag name empty")
        row = conn.execute(
            "SELECT id FROM tag WHERE name = ? COLLATE NOCASE",
            (norm,),
        ).fetchone()
        if row is None:
            return {"deleted": False, "name": norm, "affected": []}
        tid = int(row[0])
        image_ids = [
            int(r[0])
            for r in conn.execute(
                "SELECT image_id FROM image_tag WHERE tag_id = ?",
                (tid,),
            )
        ]
        conn.execute("DELETE FROM tag WHERE id = ?", (tid,))
        affected: List[Tuple[int, int]] = []
        for iid in image_ids:
            ver = _rebuild_tags_csv_for_image(conn, iid)
            affected.append((iid, ver))
        return {"deleted": True, "name": norm, "affected": affected}


class PurgeZeroUsageTagsOp:
    """Delete ``tag`` rows with ``usage_count = 0`` (T36 housekeeping)."""

    def apply(self, conn: sqlite3.Connection) -> Dict[str, Any]:
        cur = conn.execute("DELETE FROM tag WHERE usage_count = 0")
        n = int(cur.rowcount) if cur.rowcount is not None else 0
        return {"removed": n}


class RenameTagOp:
    """Rename a ``tag`` and resync ``image.tags_csv`` for linked images (T36)."""

    def __init__(self, *, old_name: str, new_name: str):
        self.old_name = str(old_name or "").strip()
        self.new_name = str(new_name or "").strip()

    def apply(self, conn: sqlite3.Connection) -> Dict[str, Any]:
        old_n = _vocab.normalize_tag(self.old_name)
        new_n = _vocab.normalize_tag(self.new_name)
        if not old_n or not new_n:
            raise ValueError("tag names must be non-empty")
        if old_n == new_n:
            return {"renamed": False, "affected": []}
        row = conn.execute(
            "SELECT id FROM tag WHERE name = ? COLLATE NOCASE",
            (old_n,),
        ).fetchone()
        if row is None:
            raise KeyError(f"tag {old_n!r} not found")
        tid = int(row[0])
        clash = conn.execute(
            "SELECT id FROM tag WHERE name = ? COLLATE NOCASE AND id != ?",
            (new_n, tid),
        ).fetchone()
        if clash is not None:
            raise ValueError(f"target tag {new_n!r} already exists")
        image_ids = [
            int(r[0])
            for r in conn.execute(
                "SELECT image_id FROM image_tag WHERE tag_id = ?",
                (tid,),
            )
        ]
        conn.execute("UPDATE tag SET name = ? WHERE id = ?", (new_n, tid))
        affected: List[Tuple[int, int]] = []
        for iid in image_ids:
            ver = _rebuild_tags_csv_for_image(conn, iid)
            affected.append((iid, ver))
        return {"old": old_n, "new": new_n, "affected": affected}


class DeleteImageOp:
    """Remove one ``image`` row and dependent vocab + thumb cache rows (T20+).

    Keyed by POSIX ``path`` as stored in ``image`` (C-1).  Idempotent: if
    the path is absent, returns ``None``; otherwise the deleted id for WS
    broadcast.  Does not delete on-disk files — watcher handles FS truth.
    """

    def __init__(self, *, path: str):
        self.path = str(path)

    def apply(self, conn: sqlite3.Connection) -> Optional[int]:
        row = conn.execute(
            "SELECT id FROM image WHERE path = ?", (self.path,),
        ).fetchone()
        if row is None:
            return None
        image_id = int(row[0])
        _delete_image_row_by_id(conn, image_id)
        return image_id


class UnindexCustomRootOp:
    """Drop all ``image`` rows for a removable root and delete its ``folder`` rows."""

    def __init__(self, *, root_id: int, root_path: str):
        self.root_id = int(root_id)
        self.root_path = str(root_path)

    def apply(self, conn: sqlite3.Connection) -> None:
        root_pp = Path(self.root_path).resolve(strict=False).as_posix().rstrip("/")
        for (iid,) in conn.execute(
            "SELECT id FROM image WHERE folder_id = ?",
            (self.root_id,),
        ).fetchall():
            _delete_image_row_by_id(conn, int(iid))
        like_pat = _sql_like_escape(root_pp) + "/%"
        for (fid,) in conn.execute(
            "SELECT id FROM folder WHERE id != ? AND (path LIKE ? ESCAPE '\\') "
            "ORDER BY length(path) DESC",
            (self.root_id, like_pat),
        ).fetchall():
            conn.execute("DELETE FROM folder WHERE id = ?", (int(fid),))
        conn.execute("DELETE FROM folder WHERE id = ?", (self.root_id,))


class RelocateFolderSubtreeDbOp:
    """After directory rename/move, rewrite ``folder.path`` / ``image.path`` rows.

    Like :class:`UpdateImagePathOp` with ``refresh_sync=False`` (T24): the files are
    only moved on disk — we do not reset ``metadata_sync_*``; otherwise the async
    PNG re-embed writer would mark every file as "updating" for no benefit.
    """

    def __init__(
        self,
        *,
        root_id: int,
        root_path: str,
        old_prefix: str,
        new_prefix: str,
        all_roots: Optional[List[Tuple[int, str]]] = None,
        secondary_relink: Optional[Tuple[int, str]] = None,
    ):
        self.root_id = int(root_id)
        self.root_path = Path(root_path).resolve(strict=False).as_posix().rstrip("/")
        self.old_prefix = Path(old_prefix).resolve(strict=False).as_posix().rstrip("/")
        self.new_prefix = Path(new_prefix).resolve(strict=False).as_posix().rstrip("/")
        ar = list(all_roots) if all_roots else [(int(root_id), str(root_path))]
        uniq: Dict[int, str] = {}
        for rid, rp in ar:
            uniq[int(rid)] = str(rp)
        self._roots_sorted: List[Tuple[int, str]] = sorted(
            uniq.items(),
            key=lambda t: -len(_norm_fs_path(str(t[1]))),
        )
        self.secondary_relink = secondary_relink

    def apply(self, conn: sqlite3.Connection) -> None:
        old = self.old_prefix
        new = self.new_prefix
        if old == new:
            return
        rp = self.root_path

        def _root_for_file(np: str) -> Tuple[int, str]:
            for rid, rpp_raw in self._roots_sorted:
                rpn = _norm_fs_path(str(rpp_raw)).rstrip("/")
                if np == rpn or np.startswith(rpn + "/"):
                    return int(rid), rpn
            r0, p0 = self._roots_sorted[0]
            return int(r0), _norm_fs_path(str(p0)).rstrip("/")

        folder_updates: List[Tuple[int, str]] = []
        for fid, pth in conn.execute("SELECT id, path FROM folder"):
            if int(fid) == int(self.root_id):
                continue
            pn = _norm_fs_path(str(pth))
            if pn == old or pn.startswith(old + "/"):
                folder_updates.append((int(fid), pn))
        folder_updates.sort(key=lambda t: -len(t[1]))
        for fid, pn in folder_updates:
            if pn == old:
                np = new
            else:
                np = new + pn[len(old):]
            conn.execute(
                "UPDATE folder SET path = ?, display_name = ? WHERE id = ?",
                (np, Path(np).name, int(fid)),
            )

        for row in conn.execute("SELECT id, path FROM image"):
            iid = int(row[0])
            pn = _norm_fs_path(str(row[1]))
            if not (pn.startswith(old + "/") or pn == old):
                continue
            if pn == old:
                continue
            np = new + pn[len(old):]
            try:
                st = os.stat(np)
            except OSError:
                continue
            mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
            file_size = int(st.st_size)
            rid, rpn = _root_for_file(np)
            rel = np[len(rpn) + 1:] if len(np) > len(rpn) else ""
            conn.execute(
                "UPDATE image SET path = ?, folder_id = ?, relative_path = ?, "
                "file_size = ?, mtime_ns = ?, version = version + 1 "
                "WHERE id = ?",
                (np, int(rid), rel, file_size, mtime_ns, iid),
            )

        _relink_folder_parent_ids(conn, root_id=int(self.root_id), root_pp=rp)
        if self.secondary_relink:
            tid, tp = self.secondary_relink
            _relink_folder_parent_ids(conn, root_id=int(tid), root_pp=str(tp))


class PurgeFolderSubtreeDbOp:
    """Remove ``image`` + ``folder`` rows whose paths lie under a deleted subtree."""

    def __init__(self, *, subtree_prefix_posix: str):
        self.prefix = _norm_fs_path(str(subtree_prefix_posix))

    def apply(self, conn: sqlite3.Connection) -> List[int]:
        old = self.prefix
        deleted_ids: List[int] = []
        for iid, pth in conn.execute("SELECT id, path FROM image"):
            pn = _norm_fs_path(str(pth))
            if pn == old or pn.startswith(old + "/"):
                _delete_image_row_by_id(conn, int(iid))
                deleted_ids.append(int(iid))
        id_to_path: Dict[int, str] = {}
        for fid, pth in conn.execute("SELECT id, path FROM folder"):
            id_to_path[int(fid)] = _norm_fs_path(str(pth))
        to_del = [
            fid for fid, pn in id_to_path.items()
            if pn == old or pn.startswith(old + "/")
        ]
        to_del.sort(key=lambda i: -len(id_to_path[i]))
        for fid in to_del:
            conn.execute("DELETE FROM folder WHERE id = ?", (fid,))
        return deleted_ids


def _sql_like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _norm_fs_path(p: str) -> str:
    """Canonical POSIX path for DB / disk comparisons (Windows-safe)."""
    return Path(str(p)).resolve(strict=False).as_posix().rstrip("/")


def _relink_folder_parent_ids(conn: sqlite3.Connection, *, root_id: int, root_pp: str) -> None:
    """Recompute ``parent_id`` from ``path`` after subtree path edits (T33)."""
    rp = _norm_fs_path(root_pp)
    rows = []
    for fid, pth in conn.execute("SELECT id, path FROM folder"):
        pn = _norm_fs_path(str(pth))
        if int(fid) == int(root_id) or pn == rp or pn.startswith(rp + "/"):
            rows.append((int(fid), pn))
    rows.sort(key=lambda t: (len(t[1]), t[0]))

    def _find_id_for_norm(target: str) -> Optional[int]:
        for i, p in rows:
            if p == target:
                return int(i)
        return None

    for fid, pn in rows:
        if int(fid) == int(root_id):
            conn.execute(
                "UPDATE folder SET parent_id = NULL WHERE id = ?",
                (int(root_id),),
            )
            continue
        parent_norm = _norm_fs_path(str(Path(pn).parent))
        if parent_norm == rp:
            pid = int(root_id)
        else:
            found = _find_id_for_norm(parent_norm)
            pid = int(found) if found is not None else int(root_id)
        conn.execute(
            "UPDATE folder SET parent_id = ? WHERE id = ?",
            (pid, int(fid)),
        )


def _dedupe_folder_rows_by_norm_path(conn: sqlite3.Connection) -> bool:
    """Merge duplicate ``folder`` rows whose ``path`` normalizes identically (Windows)."""
    groups: Dict[str, List[int]] = {}
    for fid, pth in conn.execute("SELECT id, path FROM folder"):
        key = _norm_fs_path(str(pth))
        groups.setdefault(key, []).append(int(fid))
    mutated = False
    for _key, ids in groups.items():
        if len(ids) <= 1:
            continue
        ids.sort()
        keep = ids[0]
        for dup in ids[1:]:
            conn.execute(
                "UPDATE image SET folder_id = ? WHERE folder_id = ?",
                (keep, dup),
            )
            conn.execute(
                "UPDATE folder SET parent_id = ? WHERE parent_id = ?",
                (keep, dup),
            )
            cur = conn.execute("DELETE FROM folder WHERE id = ?", (dup,))
            if cur.rowcount:
                mutated = True
    return mutated


class ReconcileFoldersUnderRootOp:
    """Sync ``folder`` rows under one registered root with on-disk directories."""

    def __init__(self, *, root_id: int, root_path: str, root_kind: str):
        self.root_id = int(root_id)
        self.root_path = str(root_path)
        self.root_kind = str(root_kind)

    def apply(self, conn: sqlite3.Connection) -> bool:
        if not os.path.isdir(self.root_path):
            return False
        root_posix = _norm_fs_path(self.root_path)
        disk_dirs: set[str] = {root_posix}

        def _on_walk_error(exc: OSError) -> None:
            logger.warning("reconcile walk error under %s: %s", self.root_path, exc)

        for dirpath, dirnames, _names in os.walk(
            self.root_path, onerror=_on_walk_error, followlinks=False,
        ):
            _paths.prune_derivative_walk_dirnames(dirnames)
            abs_d = _norm_fs_path(str(dirpath))
            if abs_d != root_posix and _paths.is_derivative_path_excluded(
                abs_d + "/.__probe__.png", root_posix,
            ):
                continue
            disk_dirs.add(abs_d)

        rows_here: List[Tuple[int, str, str]] = []
        for fid, pth in conn.execute("SELECT id, path FROM folder"):
            raw = str(pth)
            pn = _norm_fs_path(raw)
            if int(fid) == int(self.root_id) or pn == root_posix or pn.startswith(
                root_posix + "/",
            ):
                rows_here.append((int(fid), raw, pn))

        db_paths_norm = {r[2] for r in rows_here}
        norm_to_fid: Dict[str, int] = {}
        for fid, _raw, pn in rows_here:
            norm_to_fid[pn] = int(fid)

        prefix = root_posix + "/"
        mutated = False
        to_delete = [
            (norm_to_fid[pn], pn)
            for pn in db_paths_norm
            if pn != root_posix and pn.startswith(prefix) and pn not in disk_dirs
        ]
        to_delete.sort(key=lambda x: -len(x[1]))
        for fid, _pn in to_delete:
            cur = conn.execute("DELETE FROM folder WHERE id = ?", (fid,))
            if cur.rowcount:
                mutated = True

        missing = [p for p in sorted(disk_dirs) if p not in db_paths_norm]
        n_root = len(Path(root_posix).parts)

        def _sub_depth(p: str) -> int:
            return len(Path(p).parts) - n_root

        missing.sort(key=_sub_depth)
        for pth in missing:
            parent = _norm_fs_path(str(Path(pth).parent))
            if parent == root_posix:
                parent_id = self.root_id
            else:
                prow = conn.execute(
                    "SELECT id FROM folder WHERE "
                    "replace(replace(path, char(92), '/'), '//', '/') = ?",
                    (parent,),
                ).fetchone()
                if prow is None:
                    continue
                parent_id = int(prow[0])
            part = Path(pth).name
            cur = conn.execute(
                "INSERT OR IGNORE INTO folder"
                "(path, kind, parent_id, display_name, removable) "
                "VALUES (?, ?, ?, ?, ?)",
                (pth, self.root_kind, parent_id, part, 0),
            )
            if cur.rowcount:
                mutated = True

        if _dedupe_folder_rows_by_norm_path(conn):
            mutated = True
            _relink_folder_parent_ids(conn, root_id=int(self.root_id), root_pp=root_posix)
        elif mutated:
            _relink_folder_parent_ids(conn, root_id=int(self.root_id), root_pp=root_posix)

        if mutated:
            from . import ws_hub as _ws_hub

            _ws_hub.broadcast(
                _ws_hub.FOLDER_CHANGED,
                {"root_id": self.root_id},
            )
        return mutated


# T05: real (non-placeholder) op for registering a root folder. Lives here
# so that folders.py never touches a write connection directly — preserves
# the WriteQueue invariant (PROJECT_STATE §4 #15 / AI_RULES R5.5). Defined
# alongside the placeholder ops rather than inside folders.py to keep all
# op classes discoverable from a single module (ARCHITECTURE §2.1).
class EnsureFolderOp:
    """Idempotently INSERT a row into ``folder``.

    INSERT OR IGNORE makes the op safe to enqueue on every startup; the
    UNIQUE(path) index on ``folder`` decides idempotency. ``parent_id``
    defaults to NULL (= registered root); discovered sub-folders are not
    in T05's scope (T07 owns that wiring).
    """

    def __init__(self, *, path: str, kind: str, removable: int,
                 display_name: str, parent_id: Optional[int] = None):
        self.path = path
        self.kind = kind
        self.removable = int(removable)
        self.display_name = display_name
        self.parent_id = parent_id

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT OR IGNORE INTO folder"
            "(path, kind, parent_id, display_name, removable) "
            "VALUES (?, ?, ?, ?, ?)",
            (self.path, self.kind, self.parent_id,
             self.display_name, self.removable),
        )


# T08: real op for the thumbnail_cache bookkeeping row written after a
# .webp has already been materialised on disk ("先物理后入队", §4.5).
# INSERT OR REPLACE keeps the row fresh if the same hash_key is written
# twice (e.g. a regeneration after a transient disk error) — hash_key is
# derived from (path, mtime_ns) so collisions on a stable file are a
# no-op rewrite, and mtime_ns changes produce a brand-new PK entirely.
class InsertThumbCacheOp:
    """Record a freshly-generated WebP thumbnail in ``thumbnail_cache``."""

    def __init__(self, *, hash_key: str, image_id: int,
                 size_bytes: int, created_at: int, last_accessed: int):
        self.hash_key = hash_key
        self.image_id = int(image_id)
        self.size_bytes = int(size_bytes)
        self.created_at = int(created_at)
        self.last_accessed = int(last_accessed)

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT OR REPLACE INTO thumbnail_cache"
            "(hash_key, image_id, size_bytes, created_at, last_accessed) "
            "VALUES (?, ?, ?, ?, ?)",
            (self.hash_key, self.image_id, self.size_bytes,
             self.created_at, self.last_accessed),
        )


class SetSyncStatusOp:
    """Mark PNG metadata sync as ``ok`` only if ``version`` still matches (T17).

    When ``refresh_file_size`` and ``refresh_mtime_ns`` are both set (after a
    successful :func:`metadata.write_xyz_chunks`), the row's on-disk
    fingerprint is updated in the same UPDATE so the file-watcher
    :func:`indexer.index_one` short-circuits instead of enqueueing a redundant
    :class:`UpsertImageOp` + ``image.upserted`` storm (bulk move / batch sync).
    """

    def __init__(
        self,
        *,
        image_id: int,
        expected_version: int,
        refresh_file_size: Optional[int] = None,
        refresh_mtime_ns: Optional[int] = None,
    ):
        self.image_id = int(image_id)
        self.expected_version = int(expected_version)
        self.refresh_file_size = (
            None if refresh_file_size is None else int(refresh_file_size)
        )
        self.refresh_mtime_ns = (
            None if refresh_mtime_ns is None else int(refresh_mtime_ns)
        )

    def apply(self, conn: sqlite3.Connection) -> None:
        if (
            self.refresh_file_size is not None
            and self.refresh_mtime_ns is not None
        ):
            conn.execute(
                "UPDATE image SET "
                "metadata_sync_status = 'ok', "
                "metadata_sync_retry_count = 0, "
                "metadata_sync_next_retry_at = NULL, "
                "metadata_sync_last_error = NULL, "
                "file_size = ?, "
                "mtime_ns = ? "
                "WHERE id = ? AND version = ?",
                (
                    self.refresh_file_size,
                    self.refresh_mtime_ns,
                    self.image_id,
                    self.expected_version,
                ),
            )
        else:
            conn.execute(
                "UPDATE image SET "
                "metadata_sync_status = 'ok', "
                "metadata_sync_retry_count = 0, "
                "metadata_sync_next_retry_at = NULL, "
                "metadata_sync_last_error = NULL "
                "WHERE id = ? AND version = ?",
                (self.image_id, self.expected_version),
            )


class SetSyncFailedOp:
    """Record a failed PNG sync with exponential ``next_retry_at`` (T17)."""

    def __init__(self, *, image_id: int, expected_version: int,
                 error: str, now: int):
        self.image_id = int(image_id)
        self.expected_version = int(expected_version)
        self.error = (error or "")[:256]
        self.now = int(now)

    def apply(self, conn: sqlite3.Connection) -> None:
        row = conn.execute(
            "SELECT metadata_sync_retry_count FROM image "
            "WHERE id = ? AND version = ?",
            (self.image_id, self.expected_version),
        ).fetchone()
        if row is None:
            return
        old = int(row[0])
        new = old + 1
        if new >= 3:
            next_at = None
        else:
            next_at = self.now + 5 * (2 ** old)
        conn.execute(
            "UPDATE image SET "
            "metadata_sync_status = 'failed', "
            "metadata_sync_retry_count = ?, "
            "metadata_sync_next_retry_at = ?, "
            "metadata_sync_last_error = ? "
            "WHERE id = ? AND version = ?",
            (new, next_at, self.error, self.image_id, self.expected_version),
        )


class SetSyncHardFailedOp:
    """Mark sync as permanently failed without retries (e.g. non-PNG) — T17."""

    def __init__(self, *, image_id: int, expected_version: int, error: str):
        self.image_id = int(image_id)
        self.expected_version = int(expected_version)
        self.error = (error or "")[:256]

    def apply(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE image SET "
            "metadata_sync_status = 'failed', "
            "metadata_sync_retry_count = 3, "
            "metadata_sync_next_retry_at = NULL, "
            "metadata_sync_last_error = ? "
            "WHERE id = ? AND version = ?",
            (self.error, self.image_id, self.expected_version),
        )


# -- Read side (T09) -------------------------------------------------------
#
# All read APIs are synchronous, open a short-lived ``db.connect_read``
# connection per call, and never touch the WriteQueue (ARCHITECTURE §4.2:
# reads go directly through WAL-backed read connections so writer
# pressure cannot block them). Callers in the future HTTP layer (T10)
# are expected to wrap each call in ``loop.run_in_executor`` per C-2.

_PathArg = Union[str, Path]

DEFAULT_PAGE_SIZE: int = 200      # SPEC §7.3 default limit
MAX_PAGE_SIZE: int = 500          # clamp: keep per-request work bounded
# Bounded COUNT budget. Under this threshold the total is exact; at or
# above it we report ``approximate=True`` without computing further.
# The count query is ``SELECT COUNT(*) FROM (SELECT id ... LIMIT :cap)``
# so its runtime is bounded by the LIMIT, not by the full row count —
# this satisfies SPEC §7.3 / §8.4's 25 ms budget deterministically
# without resorting to ``set_progress_handler`` timer tricks
# (PROJECT_STATE §7 #5 explicitly left the choice to T09).
TOTAL_ESTIMATE_CAP: int = 5000

# SPEC §7.7 / NFR-4 — autocomplete row cap (HTTP may clamp further).
VOCAB_LOOKUP_DEFAULT_LIMIT: int = 20
VOCAB_LOOKUP_MAX_LIMIT: int = 100


_VALID_SORT_KEYS: frozenset = frozenset({"name", "time", "size", "folder"})
_VALID_SORT_DIRS: frozenset = frozenset({"asc", "desc"})
_VALID_FAVORITE_STATES: frozenset = frozenset({"all", "yes", "no"})
_VALID_METADATA_PRESENCE: frozenset = frozenset({"all", "yes", "no"})
_VALID_PROMPT_MATCH_MODE: frozenset = frozenset({"prompt", "word", "string"})

# §11 F03 — row counts as having Comfy-derived metadata when any indexed
# ComfyUI column is non-empty / non-null (gallery-only mirror fields excluded).
_HAS_COMFY_METADATA_SQL = (
    "("
    "(TRIM(COALESCE(image.positive_prompt, '')) != '') OR "
    "(TRIM(COALESCE(image.negative_prompt, '')) != '') OR "
    "(TRIM(COALESCE(image.model, '')) != '') OR "
    "image.seed IS NOT NULL OR "
    "image.cfg IS NOT NULL OR "
    "(TRIM(COALESCE(image.sampler, '')) != '') OR "
    "(TRIM(COALESCE(image.scheduler, '')) != '') OR "
    "(COALESCE(image.workflow_present, 0) != 0)"
    ")"
)


@dataclass(frozen=True)
class SortSpec:
    """Sort envelope — SPEC §6.2.

    ``key`` maps to an ``image`` column per T09's SQL helpers:
      * ``name``   → ``filename_lc``  (hits ``idx_image_filename_lc``)
      * ``time``   → ``created_at``   (hits ``idx_image_created_at``)
      * ``size``   → ``file_size``    (hits ``idx_image_file_size``)
      * ``folder`` → lowercased line-header label (root ``display_name`` /
        ``kind`` + optional ``/`` + parent dir of ``relative_path``),
        matching the gallery UI section title (see ``folder_header.py``).
    """
    key: str = "time"
    dir: str = "desc"

    def __post_init__(self) -> None:
        if self.key not in _VALID_SORT_KEYS:
            raise ValueError(f"unknown sort key: {self.key!r}")
        if self.dir not in _VALID_SORT_DIRS:
            raise ValueError(f"unknown sort dir: {self.dir!r}")


@dataclass(frozen=True)
class FilterSpec:
    """Query filter — SPEC §6.2 + FR-3 series.

    ``tags_and`` and ``prompts_and`` must be **already normalised** by
    the HTTP layer (``routes._parse_filter``) or tests. Values must match
    ``tag.name`` / ``prompt_token.token`` as stored by the indexer (T15).
    ``words_and`` (§11 F04 *word* mode) matches ``word_token.token`` from
    comma+space lexemes on ``positive_prompt`` / wire blobs.

    ``date_after`` / ``date_before`` are Unix epoch seconds
    (half-open: ``after <= created_at < before``) to match the on-disk
    ``image.created_at`` column (int seconds).  T10 will convert the
    ISO-8601 wire format to epoch before constructing a ``FilterSpec``.
    """
    name: Optional[str] = None
    favorite: str = "all"         # 'all' | 'yes' | 'no'
    model: Optional[str] = None
    date_after: Optional[int] = None
    date_before: Optional[int] = None
    folder_id: Optional[int] = None
    recursive: bool = False
    tags_and: Tuple[str, ...] = field(default_factory=tuple)
    prompts_and: Tuple[str, ...] = field(default_factory=tuple)
    words_and: Tuple[str, ...] = field(default_factory=tuple)
    metadata_presence: str = "all"
    prompt_match_mode: str = "prompt"
    prompt_substrings: Tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.favorite not in _VALID_FAVORITE_STATES:
            raise ValueError(f"invalid favorite state: {self.favorite!r}")
        if self.metadata_presence not in _VALID_METADATA_PRESENCE:
            raise ValueError(f"invalid metadata_presence: {self.metadata_presence!r}")
        if self.prompt_match_mode not in _VALID_PROMPT_MATCH_MODE:
            raise ValueError(f"invalid prompt_match_mode: {self.prompt_match_mode!r}")


@dataclass(frozen=True)
class SelectionSpec:
    """Bulk selection envelope (SPEC §6.2) — T23.

    ``all_except`` uses a server-side subquery; ``explicit`` is bound as
    ``id IN (…)`` without re-listing the active filter.
    """
    mode: str
    explicit_ids: Tuple[int, ...] = field(default_factory=tuple)
    filter: Optional[FilterSpec] = None
    excluded_ids: Tuple[int, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.mode not in ("explicit", "all_except"):
            raise ValueError("SelectionSpec.mode must be 'explicit' or 'all_except'")
        if self.mode == "explicit" and not self.explicit_ids:
            raise ValueError("explicit mode requires a non-empty id set")
        for i in self.explicit_ids:
            if int(i) < 1:
                raise ValueError("explicit ids must be positive")
        for i in self.excluded_ids:
            if int(i) < 1:
                raise ValueError("excluded_ids must be positive")


@dataclass(frozen=True)
class ImageRecord:
    """Flat image DTO.

    T10 serialises this to the nested JSON shape of SPEC §6.2
    (``folder{...}``, ``size{...}``, ``metadata{...}``, ``gallery{...}``)
    and injects ``thumb_url`` / ``raw_url``.  ``mtime_ns`` is exposed
    because the T10 thumb URL cache-buster ``?v=<mtime_ns>`` depends on
    it (§4 #32 / T08).  ``sync_status`` / ``version`` wire inside
    ``gallery.{sync_status,version}`` (T16).
    """
    id: int
    path: str
    folder_id: int
    folder_kind: str
    folder_display_name: Optional[str]
    relative_path: str
    relative_dir: str
    filename: str
    ext: str
    width: Optional[int]
    height: Optional[int]
    file_size: Optional[int]
    mtime_ns: Optional[int]
    created_at: Optional[int]
    positive_prompt: Optional[str]
    negative_prompt: Optional[str]
    model: Optional[str]
    seed: Optional[int]
    cfg: Optional[float]
    sampler: Optional[str]
    scheduler: Optional[str]
    has_workflow: bool
    favorite: bool
    tags: Tuple[str, ...]
    sync_status: str
    version: int


@dataclass(frozen=True)
class FolderNode:
    """Folder-tree DTO — SPEC §6.2.

    ``image_count_self`` / ``image_count_recursive`` are populated only
    when ``folder_tree(include_counts=True)``; otherwise both are None.
    """
    id: int
    path: str
    kind: str
    display_name: Optional[str]
    parent_id: Optional[int]
    removable: bool
    children: Tuple["FolderNode", ...]
    image_count_self: Optional[int]
    image_count_recursive: Optional[int]


@dataclass(frozen=True)
class ListPage:
    items: Tuple[ImageRecord, ...]
    next_cursor: Optional[str]
    total: int
    total_approximate: bool


@dataclass(frozen=True)
class Neighbors:
    prev_id: Optional[int]
    next_id: Optional[int]


# ---- SQL-building helpers (T09 internal) ---------------------------------

# SELECT list shared by get_image / list_images / neighbors.  The LEFT
# JOIN to ``folder`` is safe because ``image.folder_id`` is constrained
# to a registered root (PROJECT_STATE §4 #27); the LEFT is defensive
# against transient rows during migration.
_FOLDER_LINE_SORT_SQL = (
    "lower(xyz_folder_line_header("
    "image.relative_path, folder.display_name, folder.kind))"
)
_IMAGE_SELECT = (
    "SELECT image.id, image.path, image.folder_id, "
    "image.relative_path, image.filename, image.filename_lc, image.ext, "
    "image.width, image.height, image.file_size, image.mtime_ns, "
    "image.created_at, image.positive_prompt, image.negative_prompt, "
    "image.model, image.seed, image.cfg, image.sampler, image.scheduler, "
    "image.workflow_present, image.favorite, image.tags_csv, "
    "image.metadata_sync_status, image.version, "
    "folder.kind AS folder_kind, folder.display_name AS folder_display_name, "
    f"{_FOLDER_LINE_SORT_SQL} AS folder_line_header "
    "FROM image LEFT JOIN folder ON folder.id = image.folder_id"
)


# Maps public sort key → SQL expression for ``ORDER BY`` / cursor predicates.
# ``name`` / ``time`` / ``size`` hit dedicated indexes; ``folder`` uses the
# ``xyz_folder_line_header`` UDF (label order, not ``path``).
def _sort_column(key: str) -> str:
    # Use a local conditional rather than a dict so the SQL literal is
    # never built from user input — keeps any future grep-for-injection
    # audit trivial.
    if key == "name":
        return "image.filename_lc"
    if key == "time":
        return "image.created_at"
    if key == "size":
        return "image.file_size"
    if key == "folder":
        return _FOLDER_LINE_SORT_SQL
    raise ValueError(f"unknown sort key: {key!r}")


def _cursor_null_sentinel(key: str) -> Any:
    # ``file_size`` / ``created_at`` can be NULL (rare, but possible on
    # header-broken files). ``ORDER BY col`` in SQLite places NULLs
    # first in ASC and last in DESC; for cursor stability we normalise
    # NULLs to a deterministic sentinel on both sides of the comparison.
    if key in ("name", "folder"):
        return ""
    return 0


def _encode_cursor(sort_val: Any, last_id: int) -> str:
    raw = json.dumps({"v": sort_val, "id": int(last_id)},
                     separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(token: str) -> Tuple[Any, int]:
    # Re-pad to a multiple of 4 for urlsafe_b64decode; the strip/pad
    # dance keeps the wire token free of ``=`` which some HTTP clients
    # mangle in URLs.
    pad = "=" * (-len(token) % 4)
    raw = base64.urlsafe_b64decode((token + pad).encode("ascii"))
    obj = json.loads(raw.decode("utf-8"))
    return obj["v"], int(obj["id"])


def _folder_row(
    conn: sqlite3.Connection, folder_id: int
) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT id, path, parent_id FROM folder WHERE id = ?",
        (folder_id,),
    ).fetchone()


def _folder_root_and_prefix(
    conn: sqlite3.Connection, folder_id: int
) -> Optional[Tuple[int, str]]:
    """Return ``(root_id, relative_prefix_with_trailing_slash_or_empty)``.

    Climbs ``folder.parent_id`` until a root (``parent_id IS NULL``) is
    reached, then computes the selected folder's POSIX path relative to
    that root.  Result is ``("" if the folder IS the root else "sub/")``.
    Returns ``None`` if the folder id is unknown.

    The prefix is designed to be dropped straight into a
    ``relative_path LIKE :prefix || '%'`` clause — which, together with
    ``folder_id = :root_id``, uses the composite index
    ``idx_image_folder_rel (folder_id, relative_path)``.  See
    PROJECT_STATE §4 #27: images always carry the *root*'s folder_id,
    so recursive filtering is a prefix match on ``relative_path``
    (hinted §7 #4 CTE-over-``folder_id IN`` is wrong for this schema
    and would return empty for any sub-folder selection).
    """
    row = _folder_row(conn, folder_id)
    if row is None:
        return None
    sub_path = str(row["path"])
    sub_id = int(row["id"])
    if row["parent_id"] is None:
        return sub_id, ""

    # Climb to the root. Depth is bounded by directory nesting (< ~10
    # in practice); each step is a point-query hit on folder.id PK.
    cur = row
    while cur["parent_id"] is not None:
        parent = _folder_row(conn, int(cur["parent_id"]))
        if parent is None:
            # Broken chain — defensive; should never happen given T07's
            # _ensure_folder_chain invariant. Returning NOMATCH makes
            # the caller's WHERE clause select 0 rows cleanly.
            return sub_id, "\x00NOMATCH\x00"
        cur = parent
    root_id = int(cur["id"])
    root_path = str(cur["path"]).rstrip("/")

    if sub_path == root_path or sub_path == root_path + "/":
        return root_id, ""
    if not sub_path.startswith(root_path + "/"):
        return root_id, "\x00NOMATCH\x00"
    rel = sub_path[len(root_path) + 1:].rstrip("/")
    return root_id, rel + "/"


def _build_filter(
    conn: sqlite3.Connection, flt: FilterSpec
) -> Tuple[str, List[Any]]:
    """Return ``(where_sql_without_leading_WHERE, params)``.

    When ``flt`` selects a folder that cannot be resolved the WHERE
    clause short-circuits to ``1=0`` — this keeps the rest of the
    pipeline (sorting / cursor) uniform.
    """
    where: List[str] = []
    params: List[Any] = []

    if flt.folder_id is not None:
        resolved = _folder_root_and_prefix(conn, int(flt.folder_id))
        if resolved is None:
            return "1=0", []
        root_id, prefix = resolved
        where.append("image.folder_id = ?")
        params.append(root_id)
        if prefix:
            where.append("image.relative_path LIKE ?")
            params.append(prefix + "%")
            if not flt.recursive:
                # Exclude descendants: no extra '/' after the prefix.
                # ``NOT LIKE prefix || '%/%'`` does this cheaply.
                where.append("image.relative_path NOT LIKE ?")
                params.append(prefix + "%/%")
        else:
            # Root selection: recursive=True → all images under root;
            # recursive=False → flat files only (relative_path has no '/').
            if not flt.recursive:
                where.append("image.relative_path NOT LIKE ?")
                params.append("%/%")

    if flt.name:
        needle = flt.name.strip().lower()
        if needle:
            # Literal substring (not ``LIKE``): ``_`` / ``%`` in the needle must
            # not act as wildcards — two-character queries like ``_0`` are common
            # in filenames. ``filename_lc`` is already lowercased at index time.
            where.append("instr(image.filename_lc, ?) > 0")
            params.append(needle)

    if flt.favorite == "yes":
        where.append("image.favorite = 1")
    elif flt.favorite == "no":
        where.append("(image.favorite = 0 OR image.favorite IS NULL)")
    # 'all' → no predicate

    if flt.model is not None:
        where.append("image.model = ?")
        params.append(flt.model)

    if flt.date_after is not None:
        where.append("image.created_at >= ?")
        params.append(int(flt.date_after))
    if flt.date_before is not None:
        where.append("image.created_at < ?")
        params.append(int(flt.date_before))

    if flt.metadata_presence == "yes":
        where.append(_HAS_COMFY_METADATA_SQL)
    elif flt.metadata_presence == "no":
        where.append(f"NOT {_HAS_COMFY_METADATA_SQL}")

    # T15 ``image_tag`` / ``image_prompt_token`` — AND semantics on
    # normalised vocabulary keys (routes + indexer share ``vocab.*``).
    for tag in flt.tags_and:
        tok = str(tag).strip()
        if not tok:
            continue
        where.append(
            "EXISTS ("
            "SELECT 1 FROM image_tag it "
            "INNER JOIN tag t ON t.id = it.tag_id "
            "WHERE it.image_id = image.id AND t.name = ? COLLATE NOCASE"
            ")"
        )
        params.append(tok)

    if flt.prompt_match_mode == "string":
        for sub in flt.prompt_substrings:
            needle = str(sub).strip()
            if not needle:
                continue
            # §11 F05 — same underscore→space on the indexed column side so
            # substring search lines up with token storage / user queries.
            where.append(
                "instr(replace(lower(coalesce(image.positive_prompt, '')), "
                "'_', ' '), ?) > 0"
            )
            params.append(needle.lower())
    elif flt.prompt_match_mode == "word":
        for w in flt.words_and:
            tok = str(w).strip()
            if not tok:
                continue
            where.append(
                "EXISTS ("
                "SELECT 1 FROM image_word_token iwt "
                "INNER JOIN word_token wt ON wt.id = iwt.token_id "
                "WHERE iwt.image_id = image.id AND wt.token = ? COLLATE NOCASE"
                ")"
            )
            params.append(tok.lower())
    else:
        for token in flt.prompts_and:
            tok = str(token).strip()
            if not tok:
                continue
            # Underscore-insensitive match. Stored tokens keep whatever form the
            # prompt used — danbooru/NAI prompts keep underscores (e.g.
            # "slave_gear_(tsmg_nao!)") — but the query side maps "_"→space (F05).
            # Canonicalise both sides so the stored underscore token still matches.
            where.append(
                "EXISTS ("
                "SELECT 1 FROM image_prompt_token ipt "
                "INNER JOIN prompt_token pt ON pt.id = ipt.token_id "
                "WHERE ipt.image_id = image.id "
                "AND replace(pt.token, '_', ' ') = ? COLLATE NOCASE"
                ")"
            )
            params.append(tok.replace("_", " "))

    if not where:
        return "1=1", params
    return " AND ".join(where), params


def _selection_predicate_sql(
    conn: sqlite3.Connection, sel: SelectionSpec
) -> Tuple[str, List[Any]]:
    """Predicate on ``image`` / ``folder`` join rows for ``WHERE …`` (no leading WHERE)."""
    if sel.mode == "explicit":
        ids = tuple(dict.fromkeys(int(x) for x in sel.explicit_ids))
        return (
            "image.id IN (" + ",".join("?" * len(ids)) + ")",
            list(ids),
        )
    if sel.mode == "all_except":
        flt = sel.filter or FilterSpec()
        where_sql, where_params = _build_filter(conn, flt)
        inner = (
            "SELECT image.id FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            "WHERE " + where_sql
        )
        params: List[Any] = list(where_params)
        excl = tuple(dict.fromkeys(int(x) for x in sel.excluded_ids))
        if excl:
            inner += " AND image.id NOT IN (" + ",".join("?" * len(excl)) + ")"
            params.extend(excl)
        return ("image.id IN (" + inner + ")", params)
    raise ValueError("invalid SelectionSpec.mode")


def count_selection(*, db_path: _PathArg, sel: SelectionSpec) -> int:
    """Count images matching ``sel`` (T23 — same rowset as listing, no pagination)."""
    conn = _db.connect_read(db_path)
    try:
        pred, params = _selection_predicate_sql(conn, sel)
        sql = (
            "SELECT COUNT(*) FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {pred}"
        )
        (n,) = conn.execute(sql, params).fetchone()
        return int(n)
    finally:
        conn.close()


def list_selection_ids_preview(
    *, db_path: _PathArg, sel: SelectionSpec, limit: int,
) -> Tuple[int, List[int]]:
    """Return ``(total, first limit ids)`` for ``GET/POST …/resolve_selection``."""
    total = count_selection(db_path=db_path, sel=sel)
    lim = max(0, int(limit))
    if lim == 0:
        return total, []
    conn = _db.connect_read(db_path)
    try:
        pred, params = _selection_predicate_sql(conn, sel)
        sql = (
            "SELECT image.id FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {pred} ORDER BY image.id LIMIT ?"
        )
        rows = conn.execute(sql, list(params) + [lim]).fetchall()
        return total, [int(r["id"]) for r in rows]
    finally:
        conn.close()


def fetch_selection_id_paths(
    *, db_path: _PathArg, sel: SelectionSpec,
) -> List[Tuple[int, str]]:
    """Return ``(id, path)`` ordered by id — used by bulk write paths (sandbox)."""
    conn = _db.connect_read(db_path)
    try:
        pred, params = _selection_predicate_sql(conn, sel)
        sql = (
            "SELECT image.id, image.path FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {pred} ORDER BY image.id"
        )
        rows = conn.execute(sql, params).fetchall()
        return [(int(r["id"]), str(r["path"])) for r in rows]
    finally:
        conn.close()


def fetch_selection_move_sources(
    *, db_path: _PathArg, sel: SelectionSpec,
) -> List[Tuple[int, str, int, str]]:
    """Return ``(id, path, file_size, filename)`` for move preflight (T24)."""
    conn = _db.connect_read(db_path)
    try:
        pred, params = _selection_predicate_sql(conn, sel)
        sql = (
            "SELECT image.id, image.path, image.file_size, image.filename "
            "FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {pred} ORDER BY image.id"
        )
        rows = conn.execute(sql, params).fetchall()
        out: List[Tuple[int, str, int, str]] = []
        for r in rows:
            fs = r["file_size"]
            out.append(
                (
                    int(r["id"]),
                    str(r["path"]),
                    int(fs) if fs is not None else 0,
                    str(r["filename"]),
                )
            )
        return out
    finally:
        conn.close()


def fetch_selection_id_path_tags_csv(
    *, db_path: _PathArg, sel: SelectionSpec,
) -> List[Tuple[int, str, Optional[str]]]:
    """Return ``(id, path, tags_csv)`` for bulk tag merge (T23)."""
    conn = _db.connect_read(db_path)
    try:
        pred, params = _selection_predicate_sql(conn, sel)
        sql = (
            "SELECT image.id, image.path, image.tags_csv FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {pred} ORDER BY image.id"
        )
        rows = conn.execute(sql, params).fetchall()
        return [
            (int(r["id"]), str(r["path"]), r["tags_csv"])
            for r in rows
        ]
    finally:
        conn.close()


def _row_to_image_record(row: sqlite3.Row) -> ImageRecord:
    rel_path = str(row["relative_path"])
    rel_dir = rel_path.rsplit("/", 1)[0] if "/" in rel_path else ""
    tags_csv = row["tags_csv"]
    tags: Tuple[str, ...] = tuple(
        t for t in (tags_csv.split(",") if tags_csv else []) if t
    )
    return ImageRecord(
        id=int(row["id"]),
        path=str(row["path"]),
        folder_id=int(row["folder_id"]) if row["folder_id"] is not None else 0,
        folder_kind=str(row["folder_kind"]) if row["folder_kind"] is not None else "",
        folder_display_name=row["folder_display_name"],
        relative_path=rel_path,
        relative_dir=rel_dir,
        filename=str(row["filename"]),
        ext=str(row["ext"]) if row["ext"] is not None else "",
        width=row["width"],
        height=row["height"],
        file_size=row["file_size"],
        mtime_ns=row["mtime_ns"],
        created_at=row["created_at"],
        positive_prompt=row["positive_prompt"],
        negative_prompt=row["negative_prompt"],
        model=row["model"],
        seed=row["seed"],
        cfg=row["cfg"],
        sampler=row["sampler"],
        scheduler=row["scheduler"],
        has_workflow=bool(row["workflow_present"]),
        favorite=bool(row["favorite"]) if row["favorite"] is not None else False,
        tags=tags,
        sync_status=str(
            row["metadata_sync_status"] if row["metadata_sync_status"] is not None else "ok"
        ),
        version=int(row["version"] or 0),
    )


def _like_prefix_pattern(raw: str) -> str:
    """Escape ``%`` / ``_`` / ``\\`` for SQLite LIKE, then add trailing ``%``."""
    s = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return s + "%"


def _like_contains_pattern(raw: str) -> str:
    """Escape for SQLite LIKE, then wrap with ``%…%`` (substring match)."""
    s = raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{s}%"


def vocab_lookup(
    *,
    db_path: _PathArg,
    kind: str,
    prefix: str = "",
    limit: int = VOCAB_LOOKUP_DEFAULT_LIMIT,
    match_mode: str = "prefix",
) -> Tuple[Dict[str, Any], ...]:
    """Autocomplete rows: ``{name, usage_count}`` sorted per SPEC §7.7."""
    if kind not in ("tags", "prompts", "words"):
        raise ValueError(f"unknown vocab kind: {kind!r}")
    mm = str(match_mode or "prefix").strip().lower()
    if mm not in ("prefix", "contains"):
        raise ValueError(f"unknown match_mode: {match_mode!r}")
    lim = max(1, min(int(limit), VOCAB_LOOKUP_MAX_LIMIT))
    pref = (prefix or "").strip()
    conn = _db.connect_read(db_path)
    try:
        if kind == "tags":
            base = "SELECT tag.name AS name, tag.usage_count AS usage_count FROM tag"
            if not pref:
                sql = (
                    f"{base} "
                    "ORDER BY tag.usage_count DESC, tag.name ASC LIMIT ?"
                )
                rows = conn.execute(sql, (lim,)).fetchall()
            else:
                pat = (
                    _like_prefix_pattern(pref)
                    if mm == "prefix"
                    else _like_contains_pattern(pref)
                )
                sql = (
                    f"{base} "
                    "WHERE tag.name LIKE ? ESCAPE '\\' "
                    "ORDER BY tag.usage_count DESC, tag.name ASC LIMIT ?"
                )
                rows = conn.execute(sql, (pat, lim)).fetchall()
        elif kind == "prompts":
            base = (
                "SELECT prompt_token.token AS name, "
                "prompt_token.usage_count AS usage_count "
                "FROM prompt_token WHERE prompt_token.usage_count > 0"
            )
            if not pref:
                sql = (
                    f"{base} "
                    "ORDER BY prompt_token.usage_count DESC, "
                    "prompt_token.token ASC LIMIT ?"
                )
                rows = conn.execute(sql, (lim,)).fetchall()
            else:
                pat = (
                    _like_prefix_pattern(pref)
                    if mm == "prefix"
                    else _like_contains_pattern(pref)
                )
                sql = (
                    f"{base} "
                    "AND prompt_token.token LIKE ? ESCAPE '\\' "
                    "ORDER BY prompt_token.usage_count DESC, "
                    "prompt_token.token ASC LIMIT ?"
                )
                rows = conn.execute(sql, (pat, lim)).fetchall()
        else:
            base = (
                "SELECT word_token.token AS name, "
                "word_token.usage_count AS usage_count "
                "FROM word_token WHERE word_token.usage_count > 0"
            )
            if not pref:
                sql = (
                    f"{base} "
                    "ORDER BY word_token.usage_count DESC, "
                    "word_token.token ASC LIMIT ?"
                )
                rows = conn.execute(sql, (lim,)).fetchall()
            else:
                pat = (
                    _like_prefix_pattern(pref)
                    if mm == "prefix"
                    else _like_contains_pattern(pref)
                )
                sql = (
                    f"{base} "
                    "AND word_token.token LIKE ? ESCAPE '\\' "
                    "ORDER BY word_token.usage_count DESC, "
                    "word_token.token ASC LIMIT ?"
                )
                rows = conn.execute(sql, (pat, lim)).fetchall()
    finally:
        conn.close()
    return tuple(
        {"name": str(r["name"]), "usage_count": int(r["usage_count"])}
        for r in rows
    )


def list_tags_admin(
    *,
    db_path: _PathArg,
    query: str = "",
    limit: int = 10,
    offset: int = 0,
    sort_key: str = "usage",
    sort_dir: str = "desc",
) -> Dict[str, Any]:
    """Settings tag list — substring on ``tag.name``; exact match first; sortable; paged.

    Returns ``{"tags": [{"name", "usage_count"}, ...], "total": <int>}`` where ``total`` is
    the number of rows matching ``query`` (ignoring ``limit``/``offset``).
    """
    lim = max(1, min(int(limit), 100))
    off = max(0, int(offset))
    q = (query or "").strip()
    sk = (sort_key or "usage").strip().lower()
    if sk not in ("name", "usage"):
        sk = "usage"
    sd = (sort_dir or "desc").strip().lower()
    asc = sd == "asc"
    conn = _db.connect_read(db_path)
    try:
        base = "SELECT name, usage_count FROM tag"
        if sk == "name":
            order_inner = "name COLLATE NOCASE ASC" if asc else "name COLLATE NOCASE DESC"
        else:
            order_inner = (
                "usage_count ASC, name COLLATE NOCASE ASC"
                if asc
                else "usage_count DESC, name COLLATE NOCASE ASC"
            )
        if not q:
            total = int(conn.execute("SELECT COUNT(*) AS c FROM tag").fetchone()["c"])
            sql = f"{base} ORDER BY {order_inner} LIMIT ? OFFSET ?"
            rows = conn.execute(sql, (lim, off)).fetchall()
        else:
            pat = _like_contains_pattern(q)
            exact = _vocab.normalize_tag(q)
            total = int(
                conn.execute(
                    "SELECT COUNT(*) AS c FROM tag WHERE name LIKE ? ESCAPE '\\'",
                    (pat,),
                ).fetchone()["c"],
            )
            sql = (
                f"{base} WHERE name LIKE ? ESCAPE '\\' "
                "ORDER BY (CASE WHEN LOWER(name) = LOWER(?) THEN 0 ELSE 1 END), "
                f"{order_inner} LIMIT ? OFFSET ?"
            )
            rows = conn.execute(sql, (pat, exact, lim, off)).fetchall()
    finally:
        conn.close()
    tags = tuple(
        {"name": str(r["name"]), "usage_count": int(r["usage_count"])}
        for r in rows
    )
    return {"tags": tags, "total": total}


def model_vocab_label(full_name: str) -> str:
    """Human label for ``image.model`` — same canonical strip as DB (T21)."""
    n = _vocab.normalize_stored_model(full_name)
    if n is not None:
        return n
    return (full_name or "").strip()


def list_models_for_vocab(*, db_path: _PathArg) -> Tuple[Dict[str, Any], ...]:
    """Per distinct ``image.model``: canonical value, label, image usage count.

    Sorted **alphabetically** by model (FR-3e style model picker).
    """
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT model, COUNT(*) AS usage_count FROM image "
            "WHERE model IS NOT NULL AND TRIM(model) != '' "
            "GROUP BY model "
            "ORDER BY model COLLATE NOCASE",
        ).fetchall()
    finally:
        conn.close()
    out: List[Dict[str, Any]] = []
    for r in rows:
        full = str(r[0])
        out.append(
            {
                "model": full,
                "label": model_vocab_label(full),
                "usage_count": int(r[1]),
            }
        )
    return tuple(out)


# ---- Public read APIs ----------------------------------------------------

def get_image(image_id: int, *, db_path: _PathArg) -> Optional[ImageRecord]:
    """Return the ``ImageRecord`` for ``image_id`` or None if absent."""
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            _IMAGE_SELECT + " WHERE image.id = ?", (int(image_id),),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return _row_to_image_record(row)


def list_images(
    *,
    db_path: _PathArg,
    filter: Optional[FilterSpec] = None,
    sort: Optional[SortSpec] = None,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_PAGE_SIZE,
) -> ListPage:
    """Cursor-paged image listing.

    The cursor contract is ``(sort_val, id)``: to fetch the next page,
    pass the ``next_cursor`` verbatim.  Middle-of-iteration writes are
    safe — newly-inserted rows whose ``(sort_val, id)`` compare greater
    than the current cursor show up on a future page; rows deleted
    below the cursor are simply skipped (cf. TASKS T09 tests #2/#3).
    """
    flt = filter or FilterSpec()
    srt = sort or SortSpec()
    limit = max(1, min(int(limit), MAX_PAGE_SIZE))

    conn = _db.connect_read(db_path)
    try:
        where_sql, where_params = _build_filter(conn, flt)
        sort_col = _sort_column(srt.key)
        ascending = (srt.dir == "asc")
        order_sql = (
            f" ORDER BY {sort_col} {'ASC' if ascending else 'DESC'}, "
            f"image.id {'ASC' if ascending else 'DESC'}"
        )

        cursor_params: List[Any] = []
        cursor_clause = ""
        if cursor:
            try:
                last_val, last_id = _decode_cursor(cursor)
            except Exception as exc:
                raise ValueError(f"invalid cursor: {exc!r}") from exc
            # COALESCE on sort_col mirrors the NULL-sentinel applied at
            # cursor-emit time; keeps (sort_val, id) monotone across rows
            # where the sort column is NULL (file_size / created_at).
            null_default = _cursor_null_sentinel(srt.key)
            op = ">" if ascending else "<"
            cursor_clause = (
                f" AND (COALESCE({sort_col}, ?) {op} ? "
                f"OR (COALESCE({sort_col}, ?) = ? AND image.id {op} ?))"
            )
            cursor_params = [
                null_default, last_val,
                null_default, last_val, int(last_id),
            ]

        sql = (
            _IMAGE_SELECT
            + " WHERE " + where_sql
            + cursor_clause
            + order_sql
            + " LIMIT ?"
        )
        params = list(where_params) + list(cursor_params) + [limit + 1]
        rows = conn.execute(sql, params).fetchall()

        has_more = len(rows) > limit
        page_rows = rows[:limit]
        items = tuple(_row_to_image_record(r) for r in page_rows)

        next_cursor: Optional[str] = None
        if has_more and page_rows:
            last_row = page_rows[-1]
            raw_val = last_row[_sort_col_key(srt.key)]
            if raw_val is None:
                raw_val = _cursor_null_sentinel(srt.key)
            next_cursor = _encode_cursor(raw_val, int(last_row["id"]))

        # Bounded count — see TOTAL_ESTIMATE_CAP docstring.
        count_sql = (
            "SELECT COUNT(*) FROM ("
            "SELECT image.id FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {where_sql} LIMIT ?)"
        )
        count_params = list(where_params) + [TOTAL_ESTIMATE_CAP + 1]
        (total_raw,) = conn.execute(count_sql, count_params).fetchone()
        total_int = int(total_raw)
        approximate = total_int > TOTAL_ESTIMATE_CAP
        if approximate:
            total_int = TOTAL_ESTIMATE_CAP
    finally:
        conn.close()

    return ListPage(items=items, next_cursor=next_cursor,
                    total=total_int, total_approximate=approximate)


def _sort_col_key(key: str) -> str:
    # Row-dict key name to read the cursor value back from the result.
    return {
        "name":   "filename_lc",
        "time":   "created_at",
        "size":   "file_size",
        "folder": "folder_line_header",
    }[key]


def neighbors(
    image_id: int,
    *,
    db_path: _PathArg,
    filter: Optional[FilterSpec] = None,
    sort: Optional[SortSpec] = None,
) -> Neighbors:
    """Return the prev/next id within the given filter+sort ordering.

    SPEC / FR-16 / T14: returns ``None`` for either side if the current
    image is at the boundary of the result set. Wrap-around is the
    front-end's job (SPEC FR-16).  If ``image_id`` does not satisfy the
    filter (or does not exist), both sides are ``None`` — this is the
    same semantic the front-end already handles for first/last cards.
    """
    flt = filter or FilterSpec()
    srt = sort or SortSpec()

    conn = _db.connect_read(db_path)
    try:
        # Pull the anchor row's sort value. ``filename_lc`` is not in
        # ``_IMAGE_SELECT`` (it's only used for sorting), so fetch sort
        # column directly.
        sort_col = _sort_column(srt.key)
        anchor = conn.execute(
            f"SELECT {sort_col} AS sv, image.id "
            "FROM image LEFT JOIN folder ON folder.id = image.folder_id "
            "WHERE image.id = ?",
            (int(image_id),),
        ).fetchone()
        if anchor is None:
            return Neighbors(prev_id=None, next_id=None)
        anchor_val = anchor["sv"]
        if anchor_val is None:
            anchor_val = _cursor_null_sentinel(srt.key)

        # Confirm the anchor matches the filter; if not, return None/None.
        where_sql, where_params = _build_filter(conn, flt)
        in_set = conn.execute(
            f"SELECT 1 FROM image LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {where_sql} AND image.id = ? LIMIT 1",
            list(where_params) + [int(image_id)],
        ).fetchone()
        if in_set is None:
            return Neighbors(prev_id=None, next_id=None)

        ascending = (srt.dir == "asc")
        null_default = _cursor_null_sentinel(srt.key)

        def _one_side(forward: bool) -> Optional[int]:
            # forward = direction the *user* means "next":
            #   asc + forward → strictly greater (sort_val, id)
            #   desc + forward → strictly lesser
            go_gt = ascending if forward else not ascending
            op = ">" if go_gt else "<"
            order_dir = "ASC" if go_gt else "DESC"
            sql = (
                "SELECT image.id FROM image LEFT JOIN folder "
                "ON folder.id = image.folder_id "
                f"WHERE {where_sql} "
                f"AND (COALESCE({sort_col}, ?) {op} ? "
                f"OR (COALESCE({sort_col}, ?) = ? AND image.id {op} ?)) "
                f"ORDER BY COALESCE({sort_col}, ?) {order_dir}, image.id {order_dir} "
                "LIMIT 1"
            )
            params = list(where_params) + [
                null_default, anchor_val,
                null_default, anchor_val, int(image_id),
                null_default,
            ]
            row = conn.execute(sql, params).fetchone()
            return int(row["id"]) if row is not None else None

        next_id = _one_side(forward=True)
        prev_id = _one_side(forward=False)
    finally:
        conn.close()
    return Neighbors(prev_id=prev_id, next_id=next_id)


def fetch_folder_row(*, db_path: _PathArg, folder_id: int) -> Optional[Dict[str, Any]]:
    """Return one ``folder`` row as a dict, or ``None`` if missing."""
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            "SELECT id, path, kind, parent_id, display_name, removable "
            "FROM folder WHERE id = ?",
            (int(folder_id),),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "path": str(row["path"]),
        "kind": str(row["kind"]),
        "parent_id": int(row["parent_id"]) if row["parent_id"] is not None else None,
        "display_name": row["display_name"],
        "removable": int(row["removable"]),
    }


def fetch_folder_with_root(
    *, db_path: _PathArg, folder_id: int,
) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
    """Return ``(folder_row, root_row)`` where ``root_row`` is the registered root."""
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            "SELECT id, path, kind, parent_id, display_name, removable "
            "FROM folder WHERE id = ?",
            (int(folder_id),),
        ).fetchone()
        if row is None:
            return None
        cur = row
        while cur["parent_id"] is not None:
            prow = conn.execute(
                "SELECT id, path, kind, parent_id, display_name, removable "
                "FROM folder WHERE id = ?",
                (int(cur["parent_id"]),),
            ).fetchone()
            if prow is None:
                return None
            cur = prow
        folder_d = {
            "id": int(row["id"]),
            "path": str(row["path"]),
            "kind": str(row["kind"]),
            "parent_id": int(row["parent_id"]) if row["parent_id"] is not None else None,
            "display_name": row["display_name"],
            "removable": int(row["removable"]),
        }
        root_d = {
            "id": int(cur["id"]),
            "path": str(cur["path"]),
            "kind": str(cur["kind"]),
            "parent_id": None,
            "display_name": cur["display_name"],
            "removable": int(cur["removable"]),
        }
        return folder_d, root_d
    finally:
        conn.close()


def folder_tree(
    *, db_path: _PathArg, include_counts: bool = False,
) -> Tuple[FolderNode, ...]:
    """Return the forest of folders, rooted at rows with ``parent_id IS NULL``.

    ``include_counts`` issues one bounded count query per folder node.
    For a typical library (≲ a few hundred folders) the O(F) cost is
    negligible; if it ever becomes hot, T26's janitor can maintain a
    denormalised ``folder.image_count`` column (explicitly out of scope
    for T09 — AI_RULES R1.2).
    """
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT id, path, kind, parent_id, display_name, removable "
            "FROM folder ORDER BY path ASC"
        ).fetchall()

        children_of: dict = {}
        roots: List[sqlite3.Row] = []
        rows_by_id: dict = {}
        for r in rows:
            rows_by_id[int(r["id"])] = r
            if r["parent_id"] is None:
                roots.append(r)
            else:
                children_of.setdefault(int(r["parent_id"]), []).append(r)

        # Resolve each folder's (root_id, rel_prefix) once, then reuse
        # for count queries below.  Walking the tree top-down gives us
        # the prefix by extension instead of re-climbing per node.
        def _build(
            node_row: sqlite3.Row, root_id: int, rel_prefix: str,
        ) -> FolderNode:
            fid = int(node_row["id"])
            self_count: Optional[int] = None
            recursive_count: Optional[int] = None
            if include_counts:
                self_count = _count_in_folder(
                    conn, root_id, rel_prefix, recursive=False
                )
                recursive_count = _count_in_folder(
                    conn, root_id, rel_prefix, recursive=True
                )

            kids = children_of.get(fid, [])
            kid_nodes: List[FolderNode] = []
            for kid_row in kids:
                # Child path relative to root = child.path - root.path - "/"
                root_path = str(rows_by_id[root_id]["path"]).rstrip("/")
                kid_path = str(kid_row["path"])
                if _paths.is_derivative_path_excluded(kid_path, root_path):
                    continue
                if kid_path.startswith(root_path + "/"):
                    new_prefix = kid_path[len(root_path) + 1:] + "/"
                else:
                    # Defensive; T07 invariant keeps this from firing.
                    new_prefix = "\x00NOMATCH\x00"
                kid_nodes.append(_build(kid_row, root_id, new_prefix))

            return FolderNode(
                id=fid,
                path=str(node_row["path"]),
                kind=str(node_row["kind"]),
                display_name=node_row["display_name"],
                parent_id=node_row["parent_id"],
                removable=bool(node_row["removable"]),
                children=tuple(kid_nodes),
                image_count_self=self_count,
                image_count_recursive=recursive_count,
            )

        forest = tuple(_build(r, int(r["id"]), "") for r in roots)
    finally:
        conn.close()
    return forest


def _count_in_folder(
    conn: sqlite3.Connection,
    root_id: int,
    rel_prefix: str,
    *,
    recursive: bool,
) -> int:
    # Uses idx_image_folder_rel (folder_id, relative_path); the LIKE
    # patterns are prefix-anchored so SQLite can range-scan the index.
    if not rel_prefix:
        if recursive:
            sql = "SELECT COUNT(*) FROM image WHERE folder_id = ?"
            params: List[Any] = [root_id]
        else:
            sql = (
                "SELECT COUNT(*) FROM image "
                "WHERE folder_id = ? AND relative_path NOT LIKE ?"
            )
            params = [root_id, "%/%"]
    else:
        if recursive:
            sql = (
                "SELECT COUNT(*) FROM image "
                "WHERE folder_id = ? AND relative_path LIKE ?"
            )
            params = [root_id, rel_prefix + "%"]
        else:
            sql = (
                "SELECT COUNT(*) FROM image "
                "WHERE folder_id = ? AND relative_path LIKE ? "
                "AND relative_path NOT LIKE ?"
            )
            params = [root_id, rel_prefix + "%", rel_prefix + "%/%"]
    (n,) = conn.execute(sql, params).fetchone()
    return int(n)


# -- Internals -------------------------------------------------------------

class _StopSentinel:
    """Marker op used by stop() to wake the blocking get()."""

    def apply(self, conn: sqlite3.Connection) -> None:  # pragma: no cover
        return None


_STOP_SENTINEL: _StopSentinel = _StopSentinel()


# -- WriteQueue ------------------------------------------------------------

class WriteQueue:
    """Single-writer priority queue (ARCHITECTURE §4.6 + TASKS T04 UPDATED).

    One op → one transaction. A failing op only rolls back itself; its
    neighbours are committed in their own independent transactions, so
    there is no partial-commit / partial-rollback grey zone.
    """

    def __init__(self, db_path: _PathLike):
        self._db_path: Path = Path(db_path)
        # Queue entries: ``(priority, seq, op, future_or_none)``.
        # ``seq`` is monotonic → stable FIFO within the same priority class.
        self._pq: "queue.PriorityQueue[tuple[int, int, Any, Optional[Future]]]" = (
            queue.PriorityQueue()
        )
        self._seq_counter = itertools.count()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._thread_lock = threading.Lock()

    # ---- public API ------------------------------------------------------

    def enqueue_write(self, priority: int, op: Any) -> "Future":
        if priority not in _VALID_PRIORITIES:
            raise ValueError(f"unknown priority: {priority!r}")
        if not hasattr(op, "apply"):
            raise TypeError("op must implement .apply(conn)")
        fut: "Future" = Future()
        seq = next(self._seq_counter)
        self._pq.put((priority, seq, op, fut))
        return fut

    def start(self) -> None:
        with self._thread_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._supervised_loop,
                name="xyz-gallery-writer",
                daemon=True,
            )
            self._thread.start()

    def stop(self, timeout: float = 0.2) -> bool:
        """Signal the writer to exit; return True iff it joined in time."""
        with self._thread_lock:
            t = self._thread
            if t is None:
                return True
            self._stop_event.set()
            # Ensure a blocked get() wakes up even on an empty queue.
            # seq=-1 keeps the sentinel distinct from any real entry
            # (real seqs come from itertools.count() starting at 0).
            self._pq.put((HIGH, -1, _STOP_SENTINEL, None))
        t.join(timeout=timeout)
        joined = not t.is_alive()
        if joined:
            with self._thread_lock:
                self._thread = None
        return joined

    # ---- internals -------------------------------------------------------

    def _supervised_loop(self) -> None:
        # Any exception that escapes _writer_loop is logged and the loop is
        # restarted, per TASKS.md T04 ("thread crash auto-restart + error
        # log"). Normal exit (stop signalled) returns cleanly.
        while not self._stop_event.is_set():
            try:
                self._writer_loop()
                return
            except Exception:
                logger.exception("xyz.gallery writer loop crashed; restarting")
                time.sleep(_CRASH_RESTART_SLEEP_SEC)

    def _writer_loop(self) -> None:
        conn = _db.connect_write(self._db_path)
        low_streak = 0
        try:
            while not self._stop_event.is_set():
                item = self._pq.get(block=True)
                priority, _seq, op, fut = item

                if op is _STOP_SENTINEL:
                    return

                if priority == LOW:
                    low_streak += 1
                    if (
                        low_streak >= _LOW_YIELD_THRESHOLD
                        and self._has_higher_priority_waiting()
                    ):
                        # Re-enqueue this LOW; PriorityQueue will hand us
                        # the pending HIGH/MID first on the next get().
                        self._pq.put(item)
                        low_streak = 0
                        continue
                else:
                    low_streak = 0

                self._execute_single(conn, op, fut)
        finally:
            try:
                conn.close()
            except Exception:
                logger.exception("error closing write connection")

    def _execute_single(
        self,
        conn: sqlite3.Connection,
        op: Any,
        fut: Optional["Future"],
    ) -> None:
        # db.connect_write() puts sqlite3 in autocommit (isolation_level=None),
        # so BEGIN/COMMIT are explicit. Using BEGIN IMMEDIATE acquires the
        # RESERVED lock up-front — with one writer thread this is equivalent
        # to BEGIN, but it fails fast if the file was locked externally
        # (e.g. migration script mid-flight) rather than surprising op.apply.
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
                    logger.exception("ROLLBACK failed after op error")
            if fut is not None and not fut.done():
                fut.set_exception(exc)
            # Writer thread survives op-level failures — only the offending
            # op's transaction is discarded. Non-Exception BaseExceptions
            # (KeyboardInterrupt / SystemExit) are re-raised to let the
            # supervisor handle shutdown semantics.
            if not isinstance(exc, Exception):
                raise

    def _has_higher_priority_waiting(self) -> bool:
        # Peek the heap under its own mutex. Advisory — another thread may
        # enqueue between this check and the next get(), but in that case
        # PriorityQueue will simply hand us the newly-added higher op next.
        with self._pq.mutex:
            for entry in self._pq.queue:
                if entry[0] < LOW:
                    return True
        return False
