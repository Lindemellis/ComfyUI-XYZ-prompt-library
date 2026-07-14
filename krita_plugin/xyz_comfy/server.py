"""A small HTTP server inside Krita.

It runs on a daemon thread. Every handler goes through `MainThread.call`, because
Krita's API is main-thread only (see bridge.py).

Bound to 127.0.0.1 on purpose: this exposes your open document to anything that
can reach the port, so it must not be reachable off the machine.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import ops
from .bridge import MainThread
from .logger import get_logger

DEFAULT_PORT = 8765
HOST = "127.0.0.1"

logger = get_logger()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Set by serve()
    main: MainThread = None

    def log_message(self, fmt, *args):  # noqa: A003 - BaseHTTPRequestHandler's hook
        logger.debug("http: " + fmt % args)

    # ------------------------------------------------------------- replies

    def _send(self, status, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # The ComfyUI server is a different origin; the browser only ever talks to
        # ComfyUI, but a stray fetch from the ComfyUI page should not hard-fail.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload, status=200):
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _error(self, message, status=400):
        logger.warning(f"{status}: {message}")
        self._json({"ok": False, "error": message}, status=status)

    # ------------------------------------------------------------- routing

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        url = urlparse(self.path)
        query = parse_qs(url.query)
        layer = (query.get("layer") or [""])[0]

        try:
            if url.path == "/ping":
                self._json(self.main.call(ops.ping, timeout=5))

            elif url.path == "/layers":
                self._json(self.main.call(ops.list_layers))

            elif url.path == "/image":
                # Required, even though the whole document is a valid answer: a
                # mistyped parameter name must not silently hand back a flattened
                # document when the caller asked for a layer.
                if not layer:
                    return self._error(
                        "image needs a ?layer=<id>, or ?layer=document for the "
                        "whole flattened document"
                    )
                png = self.main.call(lambda: ops.export_image(layer), timeout=60)
                self._send(200, png, "image/png")

            elif url.path == "/mask":
                if not layer:
                    return self._error("mask needs a ?layer=<id>")
                png = self.main.call(lambda: ops.export_mask(layer), timeout=60)
                self._send(200, png, "image/png")

            else:
                self._error(f"no such endpoint: {url.path}", status=404)

        except ops.OpsError as exc:
            self._error(str(exc))
        except TimeoutError as exc:
            self._error(str(exc), status=504)
        except Exception as exc:  # noqa: BLE001 - never let the server thread die
            logger.exception("unhandled error")
            self._error(f"{type(exc).__name__}: {exc}", status=500)

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        url = urlparse(self.path)
        query = parse_qs(url.query)

        try:
            if url.path not in ("/layer", "/document"):
                return self._error(f"no such endpoint: {url.path}", status=404)

            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return self._error(f"POST {url.path} needs a PNG body")
            png = self.rfile.read(length)

            name = (query.get("name") or ["ComfyUI"])[0]

            if url.path == "/document":
                result = self.main.call(lambda: ops.new_document(png, name), timeout=120)
                return self._json(result)

            scale = (query.get("scale_document") or ["false"])[0].lower() in (
                "1",
                "true",
                "yes",
            )
            # Scaling a whole document is slow; give it room.
            result = self.main.call(
                lambda: ops.add_layer(png, name, scale), timeout=180
            )
            self._json(result)

        except ops.OpsError as exc:
            self._error(str(exc))
        except TimeoutError as exc:
            self._error(str(exc), status=504)
        except Exception as exc:  # noqa: BLE001
            logger.exception("unhandled error")
            self._error(f"{type(exc).__name__}: {exc}", status=500)


class Server:
    def __init__(self, port: int = DEFAULT_PORT):
        self.port = port
        self._http = None
        self._thread = None
        self.main = MainThread()  # constructed here => lives on the main thread

    def start(self) -> bool:
        if self._http is not None:
            return True
        handler = type("_BoundHandler", (_Handler,), {"main": self.main})
        try:
            self._http = ThreadingHTTPServer((HOST, self.port), handler)
        except OSError as exc:
            logger.error(
                f"could not bind {HOST}:{self.port} ({exc}). Another Krita, or "
                "another program, is already using it."
            )
            self._http = None
            return False

        self._http.daemon_threads = True
        self._thread = threading.Thread(
            target=self._http.serve_forever, name="xyz_comfy-http", daemon=True
        )
        self._thread.start()
        logger.info(f"listening on http://{HOST}:{self.port}")
        return True

    def stop(self):
        if self._http is not None:
            self._http.shutdown()
            self._http.server_close()
            self._http = None
            logger.info("stopped")
