"""Tag DB scraper — fetches danbooru/gelbooru tags and aliases via their public APIs.

Usage (standalone test):
    python -m tagdb.scraper --min-count 100 --limit 50
    python -m tagdb.scraper --login myuser --api-key abc123 --min-count 100 --limit 50

Cloudflare / TLS-fingerprint notes:
  - Danbooru sits behind Cloudflare, which serves a "Just a moment..." JS challenge
    to any client whose TLS handshake (JA3/JA4) does not look like a real browser.
    This is NOT an IP ban — a normal browser on the same IP works fine.
  - Python's urllib and the `requests` library both use the stock OpenSSL/Schannel
    handshake, so CF blocks them with HTTP 403 regardless of User-Agent or login.
    (The challenge happens before the app ever sees the auth query params, so
    credentials alone do not help.)
  - Fix: we use `curl_cffi` with `impersonate="chrome"`, which reproduces Chrome's
    TLS + HTTP/2 fingerprint and passes the challenge. No proxy is needed.
  - login + api_key are still appended when provided — they raise the API rate limit
    and unlock restricted tags, but are optional for basic scraping.
  - Gelbooru requires api_key + user_id (free account). Without them gelbooru
    scraping is skipped.

Danbooru category ints: 0=general 1=artist 3=copyright 4=character 5=meta.
"""

from __future__ import annotations

import logging
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, Generator, List, Optional

logger = logging.getLogger("xyz.tagdb.scraper")

DANBOORU_BASE = "https://danbooru.donmai.us"
DEFAULT_RATE_DELAY = 1.0
DEFAULT_MIN_POST_COUNT = 5
DEFAULT_PAGE_LIMIT = 1000

# Browser fingerprint to impersonate. curl_cffi reproduces this client's full
# TLS/HTTP2 fingerprint, which is what actually gets us past Cloudflare.
_IMPERSONATE = "chrome"

_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://danbooru.donmai.us/",
}

_INSTALL_HINT = (
    "curl_cffi is required to scrape danbooru (it impersonates a browser TLS "
    "fingerprint to pass Cloudflare). Install it with: pip install curl_cffi"
)


class ScraperDependencyError(RuntimeError):
    """Raised when curl_cffi is not installed."""


def _import_curl_cffi():
    """Import curl_cffi.requests lazily, with a clear error if it's missing."""
    try:
        from curl_cffi import requests as cffi_requests  # noqa: PLC0415
    except ImportError as exc:
        raise ScraperDependencyError(_INSTALL_HINT) from exc
    return cffi_requests


def _make_session():
    """Create a curl_cffi Session that impersonates Chrome (reuses connection)."""
    cffi_requests = _import_curl_cffi()
    return cffi_requests.Session(impersonate=_IMPERSONATE, headers=_HEADERS)


def _build_auth_params(login: Optional[str], api_key: Optional[str]) -> str:
    """Return URL query string fragment for danbooru auth, or empty string."""
    if login and api_key:
        return "&" + urllib.parse.urlencode({"login": login, "api_key": api_key})
    return ""


def _get_json(session, url: str, timeout: int = 30) -> Any:
    """HTTP GET via the impersonating session → parsed JSON.

    Raises curl_cffi.requests.HTTPError on a non-2xx response.
    """
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def iso_to_epoch(s: Optional[str]) -> int:
    """danbooru ISO8601 timestamp (e.g. '2022-01-01T15:13:03.967-05:00') → epoch int."""
    if not s:
        return 0
    try:
        return int(datetime.fromisoformat(s).timestamp())
    except ValueError:
        return 0


def epoch_to_iso(epoch: int) -> str:
    """Epoch int → ISO8601 (UTC) for danbooru `search[created_at]=>=...` filters."""
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc).isoformat()


def _paginate(
    session,
    endpoint: str,
    base_params: str,
    what: str,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield raw JSON rows from a danbooru list endpoint via id-cursor pagination.

    `base_params` must be a query fragment beginning with '&' (filters + auth).
    Uses `page=a{id}` (ids greater than {id}) to bypass danbooru's 1000-page/410
    cap, advancing by max(id) per page. Logs and stops on HTTP error.
    """
    after_id = 0
    while True:
        if stop_event and stop_event.is_set():
            logger.info("%s scrape cancelled", what)
            return

        url = (
            f"{DANBOORU_BASE}/{endpoint}"
            f"?limit={page_limit}&page=a{after_id}{base_params}"
        )
        try:
            data = _get_json(session, url)
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status == 403:
                logger.error(
                    "Danbooru returned 403 on %s (after id %d) even with browser "
                    "impersonation. Cloudflare may have tightened its challenge; "
                    "retry later or add danbooru login + api_key in TagDB settings.",
                    what, after_id,
                )
            else:
                logger.error("Error fetching %s after id %d: %s", what, after_id, exc)
            return

        if not data:
            break

        for row in data:
            yield row

        after_id = max(r["id"] for r in data)
        if len(data) < page_limit:
            break
        time.sleep(rate_delay)


def _created_at_filter(after_epoch: int) -> str:
    """`&search[created_at]=>=<iso>` fragment for incremental ('since') scrapes.

    Inclusive (`>=`) so events exactly at the watermark are re-fetched; callers
    dedupe by primary key, so re-fetching the boundary is harmless and safe.
    """
    return "&search[created_at]=" + urllib.parse.quote(">=" + epoch_to_iso(after_epoch))


def scrape_tags(
    min_post_count: int = DEFAULT_MIN_POST_COUNT,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield tag dicts from danbooru API, ordered by post_count DESC.

    Each dict: name, category (int), post_count, is_deprecated (int 0/1).

    Args:
        login:     danbooru login name (optional; raises the API rate limit).
        api_key:   danbooru API key for the account.
        stop_event: threading.Event; stops iteration when set.
    """
    # Range syntax `post_count>=N`. (The old `post_count_greater_than` param does
    # not exist on danbooru and was silently ignored, scraping ALL tags.)
    count_filter = urllib.parse.quote(f">={min_post_count}")
    base = f"&search[post_count]={count_filter}{_build_auth_params(login, api_key)}"
    session = _make_session()
    for tag in _paginate(session, "tags.json", base, "tags",
                         page_limit, rate_delay, stop_event):
        yield _map_tag(tag)


def scrape_tags_since(
    after_epoch: int,
    min_post_count: int = DEFAULT_MIN_POST_COUNT,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield tags CREATED at/after `after_epoch` (incremental new-tag pickup).

    These arrive with a real current post_count (we just read them), so the
    caller may stamp post_count_synced_at for them.
    """
    count_filter = urllib.parse.quote(f">={min_post_count}")
    base = (
        f"&search[post_count]={count_filter}"
        f"{_created_at_filter(after_epoch)}{_build_auth_params(login, api_key)}"
    )
    session = _make_session()
    for tag in _paginate(session, "tags.json", base, "new tags",
                         page_limit, rate_delay, stop_event):
        yield _map_tag(tag)


def _map_tag(tag: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "danbooru_id": int(tag["id"]),
        "name": tag["name"],
        "category": int(tag.get("category", 0)),
        "post_count": int(tag.get("post_count", 0)),
        "is_deprecated": int(bool(tag.get("is_deprecated", False))),
        "created_at": iso_to_epoch(tag.get("created_at")),
    }


def scrape_aliases(
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield active tag alias dicts {alias, canonical, created_at} from danbooru."""
    base = f"&search[status]=active{_build_auth_params(login, api_key)}"
    session = _make_session()
    for alias in _paginate(session, "tag_aliases.json", base, "aliases",
                          page_limit, rate_delay, stop_event):
        if alias.get("status") == "active":
            yield _map_alias(alias)


def scrape_aliases_since(
    after_epoch: int,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield active aliases CREATED at/after `after_epoch` (incremental)."""
    base = (
        f"&search[status]=active{_created_at_filter(after_epoch)}"
        f"{_build_auth_params(login, api_key)}"
    )
    session = _make_session()
    for alias in _paginate(session, "tag_aliases.json", base, "new aliases",
                          page_limit, rate_delay, stop_event):
        if alias.get("status") == "active":
            yield _map_alias(alias)


def _map_alias(alias: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "alias": alias["antecedent_name"],
        "canonical": alias["consequent_name"],
        "created_at": iso_to_epoch(alias.get("created_at")),
    }


def scrape_tag_versions_since(
    after_epoch: int,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield tag_version events (category/deprecation changes) at/after `after_epoch`."""
    base = f"{_created_at_filter(after_epoch)}{_build_auth_params(login, api_key)}"
    session = _make_session()
    for v in _paginate(session, "tag_versions.json", base, "tag versions",
                      page_limit, rate_delay, stop_event):
        yield {
            "version_id": int(v["id"]),
            "tag_id": int(v["tag_id"]),
            "name": v.get("name", ""),
            "category": int(v.get("category", 0)),
            "is_deprecated": int(bool(v.get("is_deprecated", False))),
            "created_at": iso_to_epoch(v.get("created_at")),
            "previous_version_id": v.get("previous_version_id"),
        }


def scrape_artist_versions_since(
    after_epoch: int,
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield artist_version events (name/other_names changes) at/after `after_epoch`."""
    import json as _json
    base = f"{_created_at_filter(after_epoch)}{_build_auth_params(login, api_key)}"
    session = _make_session()
    for v in _paginate(session, "artist_versions.json", base, "artist versions",
                      page_limit, rate_delay, stop_event):
        other = v.get("other_names")
        urls = v.get("urls")
        yield {
            "version_id": int(v["id"]),
            "artist_id": int(v["artist_id"]),
            "name": v.get("name", ""),
            "other_names": _json.dumps(other) if other is not None else None,
            "group_name": v.get("group_name"),
            "urls": _json.dumps(urls) if urls is not None else None,
            "is_banned": int(bool(v.get("is_banned", False))),
            "is_deleted": int(bool(v.get("is_deleted", False))),
            "created_at": iso_to_epoch(v.get("created_at")),
        }


def fetch_related(
    query_tag: str,
    limit: int = 20,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    order: str = "Cosine",
    timeout: int = 30,
) -> List[Dict[str, Any]]:
    """One-shot related-tag fetch for a single query tag (NOT a generator).

    related_tag.json is computed on the current corpus and costs one request per
    tag, so this is used on-demand and the result is cached with a synced_at.
    Returns rows ordered by the requested similarity, each with a `rank`.
    """
    session = _make_session()
    q = urllib.parse.quote(query_tag)
    url = (
        f"{DANBOORU_BASE}/related_tag.json"
        f"?search[query]={q}&search[order]={order}&limit={limit}"
        f"{_build_auth_params(login, api_key)}"
    )
    data = _get_json(session, url, timeout=timeout)
    out: List[Dict[str, Any]] = []
    for rank, item in enumerate(data.get("related_tags", [])):
        tag = item.get("tag", {}) or {}
        name = tag.get("name")
        if not name:
            continue
        out.append({
            "related_tag": name,
            "category": int(tag.get("category", 0)),
            "cosine": item.get("cosine_similarity"),
            "jaccard": item.get("jaccard_similarity"),
            "overlap": item.get("overlap_coefficient"),
            "frequency": item.get("frequency"),
            "rank": rank,
        })
    return out


def fetch_artist_posts(
    name: str,
    limit: int = 20,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: int = 30,
) -> List[Dict[str, Any]]:
    """Fetch recent danbooru posts for an artist tag (on-demand; not cached here).

    Returns [{id, preview_url, large_url, rating}], skipping posts without a preview.
    """
    session = _make_session()
    q = urllib.parse.quote(name)
    url = (
        f"{DANBOORU_BASE}/posts.json?tags={q}&limit={limit}"
        f"{_build_auth_params(login, api_key)}"
    )
    data = _get_json(session, url, timeout=timeout)
    out: List[Dict[str, Any]] = []
    for p in data if isinstance(data, list) else []:
        preview = p.get("preview_file_url") or p.get("large_file_url") or p.get("file_url")
        if not preview:
            continue
        # Use 360x360 variant (not padded, preserves aspect ratio)
        preview = preview.replace("/180x180/", "/360x360/")
        out.append({
            "id": p.get("id"),
            "preview_url": preview,
            "large_url": p.get("large_file_url") or p.get("file_url"),
            "rating": p.get("rating"),
        })
    # If we didn't get enough valid posts, fetch more (some posts lack image URLs)
    if len(out) < limit:
        fetch_more = min(limit * 3, 30)
        url2 = (
            f"{DANBOORU_BASE}/posts.json?tags={q}&limit={fetch_more}"
            f"{_build_auth_params(login, api_key)}"
        )
        more = _get_json(session, url2, timeout=timeout)
        seen = {r["id"] for r in out}
        for p in more if isinstance(more, list) else []:
            if len(out) >= limit:
                break
            if p.get("id") in seen:
                continue
            preview = p.get("preview_file_url") or p.get("large_file_url") or p.get("file_url")
            if not preview:
                continue
            preview = preview.replace("/180x180/", "/360x360/")
            out.append({
                "id": p.get("id"),
                "preview_url": preview,
                "large_url": p.get("large_file_url") or p.get("file_url"),
                "rating": p.get("rating"),
            })
    return out


def scrape_artist_other_names(
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield {tag, other_names:[...]} from danbooru artist entries (artist-category tags).

    artist other_names are the artist's handles on other sites + FORMER danbooru
    names (e.g. bunchi → [..., 'o_(jshn3457)', 'otintin', ...]). Distinct from wiki
    other_names (translations). Lets users find an artist by any former/alt name.
    """
    base = f"&search[any_other_name_matches]=*{_build_auth_params(login, api_key)}"
    session = _make_session()
    for a in _paginate(session, "artists.json", base, "artist other_names",
                      page_limit, rate_delay, stop_event):
        names = a.get("other_names") or []
        name = a.get("name")
        if name and names:
            yield {"tag": name, "other_names": names}


def scrape_wiki_other_names(
    page_limit: int = DEFAULT_PAGE_LIMIT,
    rate_delay: float = DEFAULT_RATE_DELAY,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    stop_event=None,
) -> Generator[Dict[str, Any], None, None]:
    """Yield {tag, other_names:[...]} from danbooru wiki pages that have other_names.

    other_names are alternate / translated names (Japanese, Chinese, romaji, …),
    e.g. aris_(blue_archive) → ['天童アリス', 'Tendou_Aris', ...]. Used to make tags
    searchable by their translations.
    """
    base = f"&search[other_names_present]=true{_build_auth_params(login, api_key)}"
    session = _make_session()
    for w in _paginate(session, "wiki_pages.json", base, "wiki other_names",
                      page_limit, rate_delay, stop_event):
        names = w.get("other_names") or []
        title = w.get("title")
        if title and names:
            yield {"tag": title, "other_names": names}


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Test-scrape a few tags from danbooru")
    parser.add_argument("--min-count", type=int, default=100)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--login", default=None)
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()

    print("=== Tags ===")
    count = 0
    for tag in scrape_tags(
        min_post_count=args.min_count,
        page_limit=args.limit,
        login=args.login,
        api_key=args.api_key,
    ):
        print(f"  {tag['name']} cat={tag['category']} count={tag['post_count']}")
        count += 1
        if count >= 10:
            print("  ... (showing first 10)")
            break

    print("\n=== Aliases (first 10) ===")
    count = 0
    for alias in scrape_aliases(
        page_limit=args.limit,
        login=args.login,
        api_key=args.api_key,
    ):
        print(f"  {alias['alias']} → {alias['canonical']}")
        count += 1
        if count >= 10:
            print("  ... (showing first 10)")
            break
