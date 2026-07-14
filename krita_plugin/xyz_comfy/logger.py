"""Logging for the Krita plugin.

Krita's Python console swallows a lot, so everything also goes to a file next to
Krita's own resources.
"""

import logging
import os
import sys
import tempfile
from pathlib import Path

_logger = None


def _log_path() -> Path:
    appdata = os.getenv("APPDATA")
    if appdata:
        base = Path(appdata) / "krita"
    else:
        base = Path(tempfile.gettempdir())
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        base = Path(tempfile.gettempdir())
    return base / "xyz_comfy.log"


def get_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger

    logger = logging.getLogger("xyz_comfy")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%H:%M:%S")

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    try:
        file = logging.FileHandler(_log_path(), encoding="utf-8")
        file.setFormatter(fmt)
        logger.addHandler(file)
    except OSError:
        pass  # a read-only APPDATA is not worth failing the plugin over

    _logger = logger
    return logger
