"""Shared Monaco hosting, independent of either version's Library database."""
from pathlib import Path

MONACO_DIR = Path(__file__).resolve().parent.parent / "web" / "monaco"


def register_monaco(server):
    # Preserve the existing URL and route name for cached clients and V3 editors.
    # Registration belongs to the server, so V3/V4 setup order cannot duplicate it.
    if getattr(server, "_xyz_prompt_monaco_registered", False):
        return
    if not MONACO_DIR.is_dir():
        print(f"[XYZ Prompt] Monaco not found at {MONACO_DIR}; the editor will not load")
        return
    server.app.router.add_static(
        "/xyz/plv3/monaco/", path=str(MONACO_DIR), name="plv3_monaco"
    )
    server._xyz_prompt_monaco_registered = True
