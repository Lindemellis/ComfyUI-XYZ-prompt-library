"""The Krita side of the work: read the layer tree, export layers and masks.

Everything here runs on Krita's MAIN thread (see bridge.py) and returns plain
data — dicts, or PNG bytes — so the HTTP layer never touches a Krita object.

Two things that are easy to get wrong and cost real time:

* **8-bit integer RGBA from Krita is B, G, R, A** — not RGBA. Qt's
  `Format_ARGB32` is exactly that byte order on a little-endian machine, so the
  bytes drop straight in; a hand-rolled RGBA reader would swap red and blue.
  Only *float* formats are actually R, G, B, A.
* **QImage does not own the buffer you hand it.** Without `.copy()` the image
  points at a QByteArray that Python is free to collect, and you get garbage or a
  crash. Always copy before the bytes go out of scope.
"""

from krita import Krita
from PyQt5.QtCore import QBuffer, QByteArray, QIODevice, Qt
from PyQt5.QtGui import QImage

#: Node.type() values that can act as a picture.
IMAGE_TYPES = frozenset(
    {
        "paintlayer",
        "grouplayer",
        "filelayer",
        "filterlayer",
        "filllayer",
        "clonelayer",
        "vectorlayer",
    }
)

#: Node.type() values that are already a single-channel mask (selectedness 0-255).
MASK_TYPES = frozenset(
    {
        "transparencymask",
        "filtermask",
        "transformmask",
        "selectionmask",
        "colorizemask",
    }
)

#: The `layer` value that means "the whole document, flattened".
DOCUMENT = "document"


class OpsError(Exception):
    """Something the user can fix — reported as a 400 with this message."""


# ------------------------------------------------------------------ documents


def _document():
    doc = Krita.instance().activeDocument()
    if doc is None:
        raise OpsError("Krita has no open document")
    return doc


def _walk(node):
    for child in node.childNodes():
        yield child
        yield from _walk(child)


def _normalise(unique_id: str) -> str:
    return unique_id.strip().strip("{}").replace("-", "").lower()


def _find(doc, layer_id: str):
    """By uniqueId, or by any unique PREFIX of one.

    The node sends a short prefix: the combo entry has to stay readable, and a
    full `{8b8e...-...}` uuid in a dropdown is not.
    """
    key = _normalise(layer_id)
    if not key:
        raise OpsError("no layer given")

    matches = [
        node
        for node in _walk(doc.rootNode())
        if _normalise(node.uniqueId().toString()).startswith(key)
    ]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise OpsError(
            f"layer {layer_id} is not in this document — refresh the layer list "
            "on the node"
        )
    names = ", ".join(repr(m.name()) for m in matches[:5])
    raise OpsError(f"layer id {layer_id} is ambiguous; it matches {names}")


def _require_u8(node):
    depth = node.colorDepth()
    if depth != "U8":
        raise OpsError(
            f"layer '{node.name()}' is {depth}, and only 8-bit (U8) layers can be "
            "read. In Krita: Image > Convert Image Color Space > 8-bit."
        )


class _Batchmode:
    """Suppress Krita's dialogs while we poke at the document."""

    def __enter__(self):
        app = Krita.instance()
        self._app = app
        self._doc = app.activeDocument()
        self._app_was = app.batchmode()
        app.setBatchmode(True)
        if self._doc is not None:
            self._doc_was = self._doc.batchmode()
            self._doc.setBatchmode(True)
        return self

    def __exit__(self, *exc):
        if self._doc is not None:
            self._doc.setBatchmode(self._doc_was)
        self._app.setBatchmode(self._app_was)
        return False


# ------------------------------------------------------------------- encoding


def _png(image: QImage) -> bytes:
    buffer = QBuffer()
    buffer.open(QIODevice.WriteOnly)
    if not image.save(buffer, "PNG"):
        raise OpsError("could not encode the image as PNG")
    return bytes(buffer.data())


def _rgba_image(data: QByteArray, width: int, height: int) -> QImage:
    expected = width * height * 4
    if data is None or data.size() != expected:
        raise OpsError(
            f"expected {expected} bytes of pixel data, got "
            f"{0 if data is None else data.size()} — the layer is probably not 8-bit"
        )
    # Krita's U8 RGBA is BGRA, which is what Format_ARGB32 reads. .copy() because
    # QImage borrows the buffer.
    return QImage(data.data(), width, height, width * 4, QImage.Format_ARGB32).copy()


def _gray_image(data: QByteArray, width: int, height: int) -> QImage:
    expected = width * height
    if data is None or data.size() != expected:
        raise OpsError(
            f"expected {expected} bytes of mask data, got "
            f"{0 if data is None else data.size()}"
        )
    return QImage(data.data(), width, height, width, QImage.Format_Grayscale8).copy()


# ---------------------------------------------------------------------- the ops


def ping() -> dict:
    doc = Krita.instance().activeDocument()
    return {
        "ok": True,
        "plugin": "xyz_comfy",
        "krita": Krita.instance().version(),
        "document": None
        if doc is None
        else {
            "name": doc.name(),
            "width": doc.width(),
            "height": doc.height(),
            "color_depth": doc.colorDepth(),
            "color_model": doc.colorModel(),
        },
    }


def list_layers() -> dict:
    doc = _document()

    def branch(node):
        # childNodes() is bottom-to-top; Krita's own layer docker shows top first.
        out = []
        for child in reversed(node.childNodes()):
            kind = child.type()
            out.append(
                {
                    "id": child.uniqueId().toString(),
                    "name": child.name(),
                    "type": kind,
                    "visible": child.visible(),
                    "is_image": kind in IMAGE_TYPES,
                    "is_mask": kind in MASK_TYPES,
                    "children": branch(child),
                }
            )
        return out

    return {
        "ok": True,
        "document": {"name": doc.name(), "width": doc.width(), "height": doc.height()},
        "layers": branch(doc.rootNode()),
    }


def export_image(layer_id: str) -> bytes:
    """A layer (or the whole document) as a document-sized PNG."""
    with _Batchmode():
        doc = _document()
        width, height = doc.width(), doc.height()

        if layer_id in ("", DOCUMENT):
            data = doc.pixelData(0, 0, width, height)
        else:
            node = _find(doc, layer_id)
            if node.type() not in IMAGE_TYPES:
                raise OpsError(
                    f"'{node.name()}' is a {node.type()}, which is a mask, not a "
                    "picture — use the mask node for it"
                )
            _require_u8(node)
            # A group's projection already includes its children. Refresh first,
            # or a layer edited a moment ago exports stale pixels.
            doc.refreshProjection()
            doc.waitForDone()
            # Document-sized, not the layer's own bounds: a layer that covers only
            # part of the canvas must still come back aligned to the canvas.
            data = node.projectionPixelData(0, 0, width, height)

        return _png(_rgba_image(data, width, height))


def export_mask(layer_id: str) -> bytes:
    """A layer as a document-sized 8-bit grayscale PNG.

    A mask node is already single-channel selectedness — read it straight. A paint
    layer or group has no such channel, so its ALPHA becomes the mask: "wherever
    you painted something" (design decision 16).
    """
    with _Batchmode():
        doc = _document()
        width, height = doc.width(), doc.height()
        node = _find(doc, layer_id)
        kind = node.type()

        doc.refreshProjection()
        doc.waitForDone()

        if kind in MASK_TYPES:
            return _png(_gray_image(node.pixelData(0, 0, width, height), width, height))

        if kind in IMAGE_TYPES:
            _require_u8(node)
            rgba = _rgba_image(
                node.projectionPixelData(0, 0, width, height), width, height
            )
            alpha = rgba.convertToFormat(QImage.Format_Alpha8)
            # Same bytes, reinterpreted: Alpha8 saves as a black PNG otherwise.
            alpha.reinterpretAsFormat(QImage.Format_Grayscale8)
            return _png(alpha)

        raise OpsError(f"'{node.name()}' is a {kind}, which cannot provide a mask")


def add_layer(png: bytes, name: str = "ComfyUI", scale_document: bool = False) -> dict:
    """Push an image back into Krita as a new paint layer, on top.

    Sizes rarely match, so (design decisions 12 and 26):

    * image smaller than the canvas -> scale the image up to the canvas. Krita is
      the canvas of record; it does not shrink.
    * image bigger, `scale_document` -> scale the whole DOCUMENT up to the image,
      every layer with it, and drop the image in 1:1. The sketch layers go soft,
      which is fine — by the time you are upscaling, the sketch is done with.
    * image bigger, not `scale_document` -> scale the image down to the canvas.
    """
    with _Batchmode():
        doc = _document()

        image = QImage.fromData(QByteArray(png), "PNG")
        if image.isNull():
            raise OpsError("could not decode the image that ComfyUI sent")
        image = image.convertToFormat(QImage.Format_ARGB32)

        grew = False
        if (image.width(), image.height()) != (doc.width(), doc.height()):
            bigger = image.width() > doc.width() or image.height() > doc.height()
            if bigger and scale_document:
                # xRes()/yRes() come back as floats but scaleImage's signature is
                # (int, int, int, int, str) — passing them straight through is a
                # TypeError.
                doc.scaleImage(
                    image.width(),
                    image.height(),
                    int(round(doc.xRes())),
                    int(round(doc.yRes())),
                    "Bicubic",
                )
                doc.waitForDone()
                grew = True
            else:
                # Exact canvas size, not KeepAspectRatio: setPixelData needs the
                # bytes to fill the rectangle we hand it, exactly.
                image = image.scaled(
                    doc.width(),
                    doc.height(),
                    Qt.IgnoreAspectRatio,
                    Qt.SmoothTransformation,
                )

        width, height = doc.width(), doc.height()

        node = doc.createNode(name or "ComfyUI", "paintlayer")
        # None => on top of the stack.
        doc.rootNode().addChildNode(node, None)

        # ARGB32's buffer is BGRA on a little-endian box, which is the byte order
        # setPixelData wants for an 8-bit RGBA layer — the same identity we rely
        # on when reading.
        expected = width * height * 4
        data = QByteArray(image.constBits().asstring(image.sizeInBytes()))
        if data.size() != expected:
            raise OpsError(
                f"internal: {data.size()} bytes of pixel data for a {width}x{height} layer"
            )
        node.setPixelData(data, 0, 0, width, height)

        doc.refreshProjection()
        doc.waitForDone()

        return {
            "ok": True,
            "layer": node.name(),
            "document_scaled": grew,
            "size": [width, height],
        }
