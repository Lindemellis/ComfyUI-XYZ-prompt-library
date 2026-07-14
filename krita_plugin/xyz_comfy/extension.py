"""The Krita Extension: start the HTTP server when Krita comes up."""

import os

from krita import Extension, Krita

from .logger import get_logger
from .server import DEFAULT_PORT, Server

logger = get_logger()


class XYZComfyExtension(Extension):
    def __init__(self, parent):
        super().__init__(parent)
        self._server = None

    def setup(self):
        """Called once, on Krita startup."""
        port = int(os.getenv("XYZ_COMFY_PORT", DEFAULT_PORT))
        self._server = Server(port)
        if self._server.start():
            logger.info(f"XYZ ComfyUI bridge ready on port {port}")
        else:
            logger.error("XYZ ComfyUI bridge failed to start — see the message above")

    def createActions(self, window):
        """Required by the Extension interface. No menu items: the plugin has no UI."""
