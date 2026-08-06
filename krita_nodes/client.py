"""HTTP client for the Krita plugin.

urllib rather than requests: ComfyUI does not depend on requests, and this needs
no more than a GET.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PORT = 8765
HOST = "127.0.0.1"

#: The `layer` value that means "the whole document, flattened".
DOCUMENT = "document"


class KritaUnreachable(Exception):
    """Krita is not running, or the plugin is not installed / not enabled."""


class KritaError(Exception):
    """Krita answered, and said no. The message is meant for the user."""


def base_url() -> str:
    port = os.getenv("XYZ_COMFY_PORT", DEFAULT_PORT)
    return f"http://{HOST}:{port}"


def _get(path: str, params: dict | None = None, timeout: float = 30.0):
    url = f"{base_url()}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"

    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read(), response.headers.get_content_type()
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            message = json.loads(body).get("error", body.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            message = body.decode("utf-8", "replace")
        raise KritaError(message) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise KritaUnreachable(
            f"could not reach the Krita plugin at {base_url()} — is Krita running "
            "with the 'XYZ ComfyUI Bridge' plugin enabled? ({exc})".format(exc=exc)
        ) from exc


def _get_json(path: str, params: dict | None = None, timeout: float = 30.0) -> dict:
    body, _ = _get(path, params, timeout)
    return json.loads(body)


def ping(timeout: float = 3.0) -> dict:
    return _get_json("/ping", timeout=timeout)


def layers(timeout: float = 10.0) -> dict:
    return _get_json("/layers", timeout=timeout)


def fetch_image(layer: str, timeout: float = 60.0) -> bytes:
    body, content_type = _get("/image", {"layer": layer}, timeout)
    if content_type != "image/png":
        raise KritaError(f"expected a PNG, got {content_type}")
    return body


def fetch_mask(layer: str, timeout: float = 60.0) -> bytes:
    body, content_type = _get("/mask", {"layer": layer}, timeout)
    if content_type != "image/png":
        raise KritaError(f"expected a PNG, got {content_type}")
    return body


def add_layer(
    png: bytes,
    name: str = "ComfyUI",
    fit: str = "fit",
    timeout: float = 180.0,
) -> dict:
    return _post("/layer", png, {"name": name, "fit": fit}, timeout)


def new_document(png: bytes, name: str = "ComfyUI", timeout: float = 120.0) -> dict:
    return _post("/document", png, {"name": name}, timeout)


def open_file(path: str, timeout: float = 120.0) -> dict:
    return _get_json("/open", {"path": path}, timeout)


def _post(path: str, png: bytes, params: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        f"{base_url()}{path}?{urllib.parse.urlencode(params)}",
        data=png,
        headers={"Content-Type": "image/png"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            message = json.loads(body).get("error", body.decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            message = body.decode("utf-8", "replace")
        raise KritaError(message) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise KritaUnreachable(
            f"could not reach the Krita plugin at {base_url()} — is Krita running "
            f"with the 'XYZ ComfyUI Bridge' plugin enabled? ({exc})"
        ) from exc
