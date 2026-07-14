"""Find and start Krita.

ComfyUI is the workspace, so reaching for Krita should not mean alt-tabbing to a
start menu. This finds krita.exe, starts it, and waits until the plugin answers —
Krita takes ~20s to come up, and a node that sent an image the instant the process
existed would just time out.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import client

DATA_DIR = Path(__file__).resolve().parent.parent / "krita_data"
SETTINGS = DATA_DIR / "settings.json"

#: Where Krita installs itself, if nothing else tells us.
WINDOWS_GUESSES = [
    r"C:\Program Files\Krita (x64)\bin\krita.exe",
    r"C:\Program Files\Krita\bin\krita.exe",
    r"C:\Program Files (x86)\Krita (x86)\bin\krita.exe",
]
MAC_GUESSES = ["/Applications/krita.app/Contents/MacOS/krita"]


class KritaNotFound(Exception):
    """We cannot find krita.exe. The user has to tell us where it is."""


def _load() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def set_executable(path: str) -> str:
    exe = Path(path).expanduser()
    if not exe.is_file():
        raise KritaNotFound(f"{exe} is not a file")
    settings = _load()
    settings["executable"] = str(exe)
    _save(settings)
    return str(exe)


def find_executable() -> str | None:
    """A saved path, then the environment, then PATH, then the usual places."""
    saved = _load().get("executable")
    if saved and Path(saved).is_file():
        return saved

    env = os.getenv("XYZ_KRITA_EXE")
    if env and Path(env).is_file():
        return env

    found = shutil.which("krita")
    if found:
        return found

    guesses = WINDOWS_GUESSES if sys.platform == "win32" else MAC_GUESSES
    for guess in guesses:
        if Path(guess).is_file():
            return guess

    if sys.platform not in ("win32", "darwin"):
        for guess in ("/usr/bin/krita", "/usr/local/bin/krita"):
            if Path(guess).is_file():
                return guess
    return None


def is_running() -> bool:
    from .installer import krita_running

    return krita_running()


def wait_for_plugin(timeout: float = 90.0) -> dict | None:
    """Poll until the plugin answers, or give up. Bounded, always."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return client.ping(timeout=2.0)
        except (client.KritaUnreachable, client.KritaError):
            time.sleep(1.0)
    return None


def launch(wait: bool = True, timeout: float = 90.0) -> dict:
    """Start Krita if it is not already up, and wait for the bridge."""
    already = is_running()

    if not already:
        exe = find_executable()
        if exe is None:
            raise KritaNotFound(
                "could not find krita.exe. Set it with POST /xyz/krita/executable, "
                "or point the XYZ_KRITA_EXE environment variable at it."
            )
        # Detached: Krita must outlive the request that started it.
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            [exe],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )

    if not wait:
        return {"ok": True, "launched": not already, "waited": False}

    ping = wait_for_plugin(timeout)
    if ping is None:
        raise RuntimeError(
            f"Krita was started but its bridge did not answer within {timeout:.0f}s. "
            "Check that the 'XYZ ComfyUI Bridge' plugin is enabled "
            "(Settings > Configure Krita > Python Plugin Manager)."
        )
    return {"ok": True, "launched": not already, "waited": True, **ping}


def status() -> dict:
    exe = find_executable()
    return {
        "executable": exe,
        "found": exe is not None,
        "running": is_running(),
    }
