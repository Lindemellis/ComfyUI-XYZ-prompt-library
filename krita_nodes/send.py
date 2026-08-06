"""Push an image into Krita — the sequence, in one place.

Two callers need exactly this: the `XYZ Krita Send To Krita` node, and the gallery's
"send to Krita" action. The steps are easy to get subtly wrong (the launch wait, and
especially the new_layer -> new_document fallback), so they live here rather than
being written out twice and drifting.
"""

from __future__ import annotations

from . import client, launcher

SEND_MODES = ("new_layer", "new_document")


def send_png(
    png: bytes,
    *,
    mode: str = "new_layer",
    layer_name: str = "ComfyUI",
    fit: str = "fit",
    launch: bool = True,
    max_wait: float = 180.0,
) -> dict:
    """Send PNG bytes to Krita and say what happened.

    `mode`:
        new_layer      — on top of the open document. If Krita has NOTHING open this
                         falls back to new_document, because `add_layer` cannot start
                         one and the alternative is a dead end.
        new_document   — always a fresh document at the image's size.

    `launch`: start Krita if it is not running and wait for the bridge to answer.
        With it off and Krita closed, raises rather than doing nothing — a caller that
        wants "quietly skip" (the node's best-effort path) checks first.

    Returns `{mode, launched, ...}` merged with the plugin's own reply.
    """
    if mode not in SEND_MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {SEND_MODES}")

    launched = False
    if not launcher.is_running():
        if not launch:
            raise client.KritaUnreachable("Krita is not running")
        launcher.launch(timeout=max(60.0, max_wait))
        launched = True

    effective = mode
    if mode == "new_layer":
        # A freshly launched Krita has no document, and that is the common case right
        # after `launch` above. Ping rather than guess: the answer also proves the
        # bridge is actually up.
        if client.ping(timeout=min(max_wait, 15.0)).get("document") is None:
            effective = "new_document"

    if effective == "new_document":
        result = client.new_document(png, name=layer_name, timeout=max_wait)
    else:
        result = client.add_layer(png, name=layer_name, fit=str(fit), timeout=max_wait)

    return {**result, "mode": effective, "requested_mode": mode, "launched": launched}
