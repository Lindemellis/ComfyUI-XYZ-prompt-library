"""Tag-lookup tool — grounds danbooru tags against the local tagdb database.

The model calls `lookup_danbooru_tags(queries, category?, limit?)`; the server runs each
query through tagdb.repo and returns trimmed `{name, post_count, category_name, aliases}`
so the model can pick tags that actually exist (preferring high post_count). English
queries only — the model translates CJK concepts to English itself (the DB has no general
ja/zh translations anyway).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:  # runtime: subpackage of the custom-node root
    from ..tagdb import repo as _tagrepo
except ImportError:  # standalone (tests)
    try:
        from tagdb import repo as _tagrepo
    except Exception:  # pragma: no cover
        _tagrepo = None

logger = logging.getLogger("xyz.llm.tools")

LOOKUP_TOOL_NAME = "lookup_danbooru_tags"

# danbooru category convention
_CATEGORY_MAP = {"general": 0, "artist": 1, "copyright": 3, "character": 4, "meta": 5}

LOOKUP_TOOL_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": LOOKUP_TOOL_NAME,
        "description": (
            "Search the local danbooru/gelbooru tag database to verify which English "
            "danbooru tags actually exist and how common they are. Pass several English "
            "candidate synonyms for a concept at once; pick the real, high-post_count "
            "results. Queries must be English (translate CJK concepts to English first)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "English candidate tag strings to look up (1-8).",
                },
                "category": {
                    "type": "string",
                    "enum": ["general", "artist", "copyright", "character", "meta"],
                    "description": "Optional category filter.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results per query (default 8).",
                },
            },
            "required": ["queries"],
        },
    },
}


def resolve_sources(settings: Dict[str, Any]) -> List[Tuple[str, Path]]:
    """Return [(source_name, db_path)] for sources enabled in settings AND installed.

    Honors the live tagdb resolvers (active snapshot or working DB) when available,
    falling back to the default file locations.
    """
    cfg = (settings or {}).get("lookup_sources", {}) or {}
    out: List[Tuple[str, Path]] = []

    dan = _resolve_one("danbooru", "danbooru.sqlite")
    if cfg.get("danbooru", True) and dan is not None:
        out.append(("danbooru", dan))
    gel = _resolve_one("gelbooru", "gelbooru.sqlite")
    if cfg.get("gelbooru", False) and gel is not None:
        out.append(("gelbooru", gel))
    return out


def _resolve_one(source: str, filename: str) -> Optional[Path]:
    try:
        from ..tagdb import routes as _tagroutes  # type: ignore
    except Exception:
        try:
            from tagdb import routes as _tagroutes  # type: ignore
        except Exception:
            _tagroutes = None
    if _tagroutes is not None:
        try:
            p = _tagroutes._active_db() if source == "danbooru" else _tagroutes._gelbooru_active_db()
            if p and Path(p).exists():
                return Path(p)
        except Exception:
            pass
    # fallback: default working-db location
    default = Path(__file__).parent.parent / "tagdb_data" / filename
    return default if default.exists() else None


def execute_lookup(args: Dict[str, Any], sources: List[Tuple[str, Path]]) -> List[Dict[str, Any]]:
    """Run the lookup. Returns a flat, de-duplicated list of trimmed tag dicts."""
    if _tagrepo is None or not sources:
        return []
    queries = args.get("queries") or []
    if isinstance(queries, str):
        queries = [queries]
    cat_name = args.get("category")
    category = _CATEGORY_MAP.get(cat_name) if cat_name else None
    if category == 0:
        category = None  # 'general' = no filter
    try:
        limit = int(args.get("limit", 8))
    except Exception:
        limit = 8
    limit = max(1, min(limit, 20))

    seen: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    multi = len(sources) >= 2

    def _search(term: str):
        if multi:
            tuples = [(name, path, None) for name, path in sources]
            return _tagrepo.search_tags_multi(tuples, term, limit=limit, category=category)
        name, path = sources[0]
        return _tagrepo.search_tags(term, path, limit=limit, category=category)

    for q in queries:
        q = (q or "").strip()
        if not q:
            continue
        # The model writes danbooru display form ("blonde hair") but the DB stores the
        # underscore form ("blonde_hair"). Search the underscore form first, then the raw.
        terms = []
        underscored = q.replace(" ", "_")
        terms.append(underscored)
        if q != underscored:
            terms.append(q)
        rows = []
        try:
            for t in terms:
                rows.extend(_search(t))
        except Exception as exc:
            logger.debug("lookup failed for %r: %s", q, exc)
        for r in rows:
            if r.get("is_deprecated"):
                continue
            name = r.get("name")
            if not name or name in seen:
                continue
            trimmed = {
                "name": name,
                "post_count": r.get("post_count", 0),
                "category_name": r.get("category_name", ""),
                "aliases": list(r.get("aliases", []) or [])[:3],
            }
            if r.get("sources") and len(r["sources"]) >= 2:
                trimmed["sources"] = r["sources"]
            seen[name] = trimmed
            order.append(name)
    return [seen[n] for n in order]
