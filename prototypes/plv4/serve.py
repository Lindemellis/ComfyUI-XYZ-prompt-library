"""Local P0 preview: serve the existing PLv3 editor and pure language endpoints.

No ComfyUI instance, database, or production route registration is involved.
Run: python prototypes/plv4/serve.py
"""
from __future__ import annotations

import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from prompt_library_v3.ast_json import to_json
from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v3.document import Document, from_text, reconcile, render
from prompt_library_v3.parser import parse
from prompt_library_v4.routes import dispatch as document_dispatch
from prompt_library_v4.model import CommandError


def js_offset(source, offset):
    return len(source[:offset].encode("utf-16-le")) // 2


def js_spans(ast, source):
    """Python spans count code points; Monaco spans count UTF-16 code units."""
    def visit(value, key=""):
        if isinstance(value, dict):
            return {k: visit(v, k) for k, v in value.items()}
        if isinstance(value, list):
            span_keys = {"span", "node", "content", "header", "set_block", "set_body",
                         "region_decl", "region_body", "value", "entry", "body"}
            if key in span_keys and len(value) == 2 and all(isinstance(v, int) for v in value):
                return [js_offset(source, v) for v in value]
            return [visit(v) for v in value]
        return value
    return visit(ast)


def diagnostics(values, source=""):
    return [dict(code=d.code, message=d.message, pos=js_offset(source, d.pos),
                 severity="error" if d.is_error else "warning") for d in values]


class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/prototypes/plv4/nested.html")
            self.end_headers()
            return
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if path == "/xyz/plv3/library/tree":
            self.reply(dict(groups=[], presets=[], folders=[], documents=[]))
            return
        if path.startswith("/xyz/plv3/monaco/"):
            self.path = "/web/monaco/" + path[len("/xyz/plv3/monaco/"):]
        elif not path.startswith(("/prototypes/plv4/", "/js/plv3/", "/js/plv4/")):
            self.send_error(404)
            return
        target = Path(self.translate_path(self.path)).resolve()
        allowed = [ROOT / "web/monaco", ROOT / "prototypes/plv4", ROOT / "js/plv3", ROOT / "js/plv4"]
        if not any(target.is_relative_to(base) for base in allowed) or not target.is_file():
            self.send_error(404)
            return
        if self.command == "HEAD":
            super().do_HEAD()
        else:
            super().do_GET()

    def do_POST(self):
        route = urlsplit(self.path).path
        if route.startswith("/xyz/plv4/document/"):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 <= size <= 2_000_000:
                    self.reply(dict(error="Preview document is too large."), 413)
                    return
                body = json.loads(self.rfile.read(size))
                self.reply(document_dispatch(route.rsplit("/", 1)[-1], body))
            except CommandError as exc:
                self.reply(dict(ok=False, code=exc.code, error=str(exc)), 409 if exc.code == "stale_revision" else 422)
            except PLv3Error as exc:
                self.reply(dict(ok=False, code=exc.diag.code, error=str(exc)), 422)
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                self.reply(dict(ok=False, code="invalid_request", error=str(exc)), 400)
            return
        if route not in ("/xyz/plv3/ast", "/xyz/plv3/compile", "/xyz/plv3/doc/sync"):
            self.reply(dict(error="This preview only exposes pure language operations."), 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 2_000_000:
                self.reply(dict(error="Preview document is too large."), 413)
                return
            body = json.loads(self.rfile.read(size))
            text = body.get("text") or ""
            if route.endswith("/ast"):
                ast, diags = parse(text, recover=True)
                self.reply(dict(ok=not any(d.is_error for d in diags), ast=js_spans(to_json(ast), text),
                                diagnostics=diagnostics(diags, text)))
            elif route.endswith("/compile"):
                result = compile_text(text, seed=int(body.get("seed") or 0),
                                      region_mode=body.get("region_mode") or "couple", recover=True)
                self.reply(dict(ok=not any(d.is_error for d in result.diagnostics),
                                text=result.text, diagnostics=diagnostics(result.diagnostics, text)))
            else:
                raw = body.get("doc")
                doc = reconcile(Document.from_json(raw), text) if raw else from_text(text)
                self.reply(dict(ok=True, doc=doc.to_json(), text=render(doc)))
        except PLv3Error as exc:
            self.reply(dict(ok=False, ast=None, text="", diagnostics=diagnostics([exc.diag], text)))
        except (ValueError, TypeError, KeyError) as exc:
            self.reply(dict(error=str(exc)), 400)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    print(f"PLv4 P0: http://127.0.0.1:{args.port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Preview).serve_forever()
