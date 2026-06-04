"""Tag-lookup tool — grounds danbooru tags against the local tagdb database.

The model calls `lookup_danbooru_tags(queries, category?, limit?)`; the server runs each
query through tagdb.repo and returns trimmed `{name, post_count, category_name, aliases}`
so the model can pick tags that actually exist (preferring high post_count). English
queries only — the model translates CJK concepts to English itself (the DB has no general
ja/zh translations anyway).
"""

from __future__ import annotations

import html as _html
import logging
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

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


# ───────────────────────────────────────────────────────────────────────────────
# Web search tool — keyless DuckDuckGo HTML scrape (reuses curl_cffi, like tagdb).
# ───────────────────────────────────────────────────────────────────────────────

WEB_SEARCH_TOOL_NAME = "web_search"

WEB_SEARCH_TOOL_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": WEB_SEARCH_TOOL_NAME,
        "description": (
            "Run a live web search and get back a list of {title, url, snippet}. Use it "
            "only when the local tag database cannot answer: to learn an unfamiliar "
            "concept's proper/booru name, to look up a character's appearance, or to find "
            "artists who draw in a requested style. Prefer queries that start with "
            "'danbooru'. Pass several related queries at once."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "queries": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Search query strings (1-4). Prefer prefixing 'danbooru'.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results per query (default 5, max 10).",
                },
            },
            "required": ["queries"],
        },
    },
}

_DDG_HTML_URL = "https://html.duckduckgo.com/html/"
_DDG_LITE_URL = "https://lite.duckduckgo.com/lite/"
_RESULT_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_SNIPPET_RE = re.compile(
    r'class="result__snippet"[^>]*>(?P<snippet>.*?)</a>', re.IGNORECASE | re.DOTALL
)
# lite.duckduckgo.com fallback layout: result-link <a> + result-snippet <td>
_LITE_LINK_RE = re.compile(
    r'<a[^>]+class="result-link"[^>]+href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_LITE_SNIPPET_RE = re.compile(
    r'class="result-snippet"[^>]*>(?P<snippet>.*?)</td>', re.IGNORECASE | re.DOTALL
)
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(s: str) -> str:
    return _html.unescape(_TAG_RE.sub("", s or "")).strip()


def _clean_ddg_href(href: str) -> str:
    """DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<url>. Unwrap it."""
    if not href:
        return ""
    if href.startswith("//"):
        href = "https:" + href
    try:
        parsed = urlparse(href)
        if "duckduckgo.com" in parsed.netloc and parsed.path.startswith("/l/"):
            target = parse_qs(parsed.query).get("uddg", [""])[0]
            if target:
                return unquote(target)
    except Exception:
        pass
    return href


def web_search_enabled(settings: Dict[str, Any]) -> bool:
    return bool((settings or {}).get("web_search_enabled", False))


def _is_blocked(status: int, text: str) -> bool:
    """DuckDuckGo serves an HTTP 202 anti-bot 'anomaly' page when it rate-limits a
    scraper; it carries no result markers."""
    if status == 202:
        return True
    low = text.lower()
    return ("anomaly" in low) and ("result__a" not in text) and ("result-link" not in text)


def _parse_results(text: str, link_re, snippet_re, query: str, limit: int,
                   seen_urls: set) -> List[Dict[str, Any]]:
    titles = list(link_re.finditer(text))
    snippets = list(snippet_re.finditer(text))
    out: List[Dict[str, Any]] = []
    for i, m in enumerate(titles):
        if len(out) >= limit:
            break
        url = _clean_ddg_href(m.group("href"))
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        title = _strip_html(m.group("title"))
        snippet = _strip_html(snippets[i].group("snippet")) if i < len(snippets) else ""
        out.append({"title": title, "url": url, "snippet": snippet[:300], "query": query})
    return out


def _search_one(cffi_requests, query: str, limit: int, seen_urls: set,
                retries: int = 2, backoff: float = 1.5) -> Tuple[List[Dict[str, Any]], bool]:
    """Run one query. Tries the html endpoint, then the lite endpoint on a block, with a
    short backoff retry. Returns (results, blocked) — `blocked` True means DDG rate-limited
    us (so the caller can tell "no data" apart from "genuinely nothing found")."""
    endpoints = [
        (_DDG_HTML_URL, "https://duckduckgo.com/", _RESULT_RE, _SNIPPET_RE),
        (_DDG_LITE_URL, "https://lite.duckduckgo.com/", _LITE_LINK_RE, _LITE_SNIPPET_RE),
    ]
    blocked_any = False
    for attempt in range(retries):
        for url, referer, link_re, snippet_re in endpoints:
            try:
                # GET (not POST): DuckDuckGo serves its 202 anti-bot page to POSTs but
                # answers GET ?q=… normally.
                resp = cffi_requests.get(
                    url, params={"q": query}, impersonate="chrome",
                    timeout=20, headers={"Referer": referer},
                )
                status = getattr(resp, "status_code", 0)
                text = getattr(resp, "text", "") or ""
            except Exception as exc:
                logger.debug("web_search request failed for %r: %s", query, exc)
                continue
            if _is_blocked(status, text):
                blocked_any = True
                continue
            results = _parse_results(text, link_re, snippet_re, query, limit, seen_urls)
            if results:
                return results, False
        # all endpoints blocked / empty — back off and retry
        if attempt < retries - 1:
            time.sleep(backoff * (attempt + 1))
    return [], blocked_any


def execute_web_search(args: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Live web search via DuckDuckGo (keyless html/lite scrape). Returns a flat,
    de-duplicated list of {title, url, snippet, query}. Never raises.

    If DDG rate-limits every query (its 202 anti-bot page), returns a single `_note`
    item so the model knows the search was *unavailable* (not that nothing exists) and
    falls back to lookup_danbooru_tags / its own knowledge instead of hallucinating."""
    try:
        from curl_cffi import requests as cffi_requests  # noqa: PLC0415
    except Exception:
        logger.debug("curl_cffi unavailable; web_search disabled")
        return [{"_note": "web search unavailable (curl_cffi missing)"}]

    queries = args.get("queries") or []
    if isinstance(queries, str):
        queries = [queries]
    try:
        limit = int(args.get("limit", 5))
    except Exception:
        limit = 5
    limit = max(1, min(limit, 10))

    out: List[Dict[str, Any]] = []
    seen_urls: set = set()
    blocked_any = False
    for q in queries[:4]:
        q = (q or "").strip()
        if not q:
            continue
        results, blocked = _search_one(cffi_requests, q, limit, seen_urls)
        out.extend(results)
        blocked_any = blocked_any or blocked

    if not out and blocked_any:
        return [{"_note": "Web search is temporarily rate-limited by DuckDuckGo and "
                          "returned no data. This does NOT mean nothing exists — rely on "
                          "lookup_danbooru_tags and your own knowledge instead."}]
    return out
