"""
Standalone test script - try multiple methods to fetch danbooru tags.

Usage:
    python tagdb/test_scrape.py
    python tagdb/test_scrape.py --proxy http://127.0.0.1:7890
    python tagdb/test_scrape.py --login yuriElise --api-key YOUR_KEY
"""

import argparse
import base64
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

DANBOORU_BASE = "https://danbooru.donmai.us"
AUTO_PROBE_PORTS = [7890, 7891, 1080, 10809, 10808, 8080, 8118, 7897]

# Several UA strings to try
USER_AGENTS = [
    # Issue #1 suggestion: iPad Safari
    ("iPad Safari",
     "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) "
     "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"),
    # Chrome desktop
    ("Chrome Win",
     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
     "AppleWebKit/537.36 (KHTML, like Gecko) "
     "Chrome/124.0.0.0 Safari/537.36"),
    # Android Chrome
    ("Chrome Android",
     "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
     "AppleWebKit/537.36 (KHTML, like Gecko) "
     "Chrome/124.0.0.6 Mobile Safari/537.36"),
    # Firefox
    ("Firefox",
     "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) "
     "Gecko/20100101 Firefox/125.0"),
]

# Endpoints to try (some may have looser Cloudflare rules)
ENDPOINTS = [
    ("tags.json (count order)",
     f"{DANBOORU_BASE}/tags.json?"
     "limit=10&search[order]=count&search[post_count_greater_than]=99"),
    ("tags.json (name order)",
     f"{DANBOORU_BASE}/tags.json?"
     "limit=10&search[order]=name"),
    ("autocomplete (tag_query)",
     f"{DANBOORU_BASE}/autocomplete?"
     "search[query]=blue&search[type]=tag_query&limit=10"),
]


def make_opener(proxy_url=None, no_proxy=False):
    if no_proxy:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if proxy_url:
        return urllib.request.build_opener(urllib.request.ProxyHandler(
            {"http": proxy_url, "https": proxy_url}
        ))
    return urllib.request.build_opener(urllib.request.ProxyHandler())


def fetch_urllib(opener, url, ua, login, api_key):
    headers = {
        "User-Agent": ua,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Referer": "https://danbooru.donmai.us/",
        "X-Requested-With": "XMLHttpRequest",
    }
    if login and api_key:
        raw = f"{login}:{api_key}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()

    # Also append auth to query string
    sep = "&" if "?" in url else "?"
    if login and api_key:
        url = url + sep + urllib.parse.urlencode({"login": login, "api_key": api_key})

    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=15) as resp:
        raw = resp.read()
        # handle gzip
        enc = resp.headers.get("Content-Encoding", "")
        if enc == "gzip":
            import gzip
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8"))


def fetch_requests(url, ua, login, api_key, proxy_url=None):
    """Try using the requests library (different TLS fingerprint)."""
    import requests  # noqa: PLC0415
    headers = {
        "User-Agent": ua,
        "Accept": "application/json",
        "Referer": "https://danbooru.donmai.us/",
    }
    auth = (login, api_key) if login and api_key else None
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    r = requests.get(url, headers=headers, auth=auth, proxies=proxies,
                     timeout=15, verify=True)
    r.raise_for_status()
    return r.json()


def probe_port(port):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.5)
        s.close()
        return True
    except OSError:
        return False


def check_data(data):
    """Return True if the response looks like valid tag data."""
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            # tags.json: has 'name', 'category', 'post_count'
            if "name" in first and ("category" in first or "post_count" in first):
                return True
            # autocomplete: has 'value', 'label', 'category'
            if "value" in first or "label" in first:
                return True
    return False


def print_sample(data):
    for item in data[:5]:
        if "name" in item:
            print(f"    {item['name']}  cat={item.get('category','-')}  "
                  f"count={item.get('post_count','-')}")
        elif "label" in item:
            print(f"    {item['label']}  cat={item.get('category','-')}")


def try_urllib(label, opener, endpoint_url, ua_name, ua, login, api_key):
    print(f"  [{label} | UA:{ua_name}] ", end="", flush=True)
    t0 = time.time()
    try:
        data = fetch_urllib(opener, endpoint_url, ua, login, api_key)
        if check_data(data):
            print(f"OK ({len(data)} items, {time.time()-t0:.1f}s)")
            print_sample(data)
            return True
        print(f"? unexpected: {str(data)[:100]}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}")
    except urllib.error.URLError as e:
        print(f"URLError: {e.reason}")
    except Exception as e:
        print(f"{type(e).__name__}: {e}")
    return False


def try_requests_lib(label, endpoint_url, ua_name, ua, login, api_key, proxy_url=None):
    print(f"  [requests lib | {label} | UA:{ua_name}] ", end="", flush=True)
    t0 = time.time()
    try:
        data = fetch_requests(endpoint_url, ua, login, api_key, proxy_url)
        if check_data(data):
            print(f"OK ({len(data)} items, {time.time()-t0:.1f}s)")
            print_sample(data)
            return True
        print(f"? unexpected: {str(data)[:100]}")
    except Exception as e:
        print(f"{type(e).__name__}: {e}")
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy", default=None)
    parser.add_argument("--login", default=None)
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()

    login   = args.login
    api_key = args.api_key

    print("=" * 70)
    print("danbooru connectivity test")
    print(f"  auth  : {'login=' + login if login else 'anonymous'}")
    print(f"  proxy : {args.proxy or '(auto-detect)'}")
    print("=" * 70)

    # Build list of (proxy_label, opener, proxy_url_or_None) to test
    proxy_configs = []
    if args.proxy:
        proxy_configs.append((f"proxy={args.proxy}", make_opener(args.proxy), args.proxy))

    # System proxy
    proxy_configs.append(("system-proxy", make_opener(None), None))

    # Auto-probe ports
    for port in AUTO_PROBE_PORTS:
        if probe_port(port):
            pu = f"http://127.0.0.1:{port}"
            proxy_configs.append((f"port={port}", make_opener(pu), pu))
            print(f"  [port probe] port {port} is OPEN -> will test")
        # else: silently skip

    # Direct (no proxy)
    proxy_configs.append(("direct", make_opener(no_proxy=True), None))

    # Check if requests is available
    has_requests = False
    try:
        import requests as _r  # noqa: F401
        has_requests = True
        print("  [info] requests library available")
    except ImportError:
        print("  [info] requests library not available (urllib only)")

    print()
    success = False
    winner = None

    for proxy_label, opener, proxy_url in proxy_configs:
        print(f"\n--- {proxy_label} ---")
        for ep_name, ep_url in ENDPOINTS:
            for ua_name, ua in USER_AGENTS:
                if try_urllib(ep_name, opener, ep_url, ua_name, ua, login, api_key):
                    success = True
                    winner = (proxy_label, ep_name, ua_name, "urllib")
                    break
            if success:
                break

            if has_requests:
                for ua_name, ua in USER_AGENTS:
                    if try_requests_lib(ep_name, ep_url, ua_name, ua, login, api_key, proxy_url):
                        success = True
                        winner = (proxy_label, ep_name, ua_name, "requests")
                        break
                if success:
                    break
        if success:
            break

    print("\n" + "=" * 70)
    if success:
        proxy_lbl, ep_lbl, ua_lbl, lib = winner
        print(f"SUCCESS!")
        print(f"  proxy    : {proxy_lbl}")
        print(f"  endpoint : {ep_lbl}")
        print(f"  UA       : {ua_lbl}")
        print(f"  library  : {lib}")
    else:
        print("FAILED - danbooru is not reachable via any tested method.")
        print("\nYou need a working proxy. Start Clash/V2Ray/etc then re-run with:")
        print("  python tagdb/test_scrape.py --proxy http://127.0.0.1:<port>")
    print("=" * 70)


if __name__ == "__main__":
    main()
