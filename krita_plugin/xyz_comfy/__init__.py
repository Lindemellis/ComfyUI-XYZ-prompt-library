"""XYZ ComfyUI bridge — a Krita plugin.

Serves the active document's layers to ComfyUI over HTTP on 127.0.0.1.
Installed by ComfyUI-XYZNodes; see krita_nodes/README.md.

Deliberately namespaced away from ComfyUI-Danbooru-Gallery's `open_in_krita`
plugin — different id, different port, different log — so both can be installed
in the same Krita without knowing about each other.
"""

from krita import Krita

from .extension import XYZComfyExtension

Krita.instance().addExtension(XYZComfyExtension(Krita.instance()))
