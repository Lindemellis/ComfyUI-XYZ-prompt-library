"""Isolated real-ComfyUI fixture. Never imports the pack's service initializer.

Run with the dev Python to prepare a scratch --base-directory; then start ComfyUI
with --cpu --disable-auto-launch --base-directory <that path>. The fixture's
Library database, user files, inputs and outputs all stay under the scratch root.
"""
from pathlib import Path
import sys
import shutil
import tempfile
import os

REPO = Path(__file__).resolve().parents[2]
SCRATCH = Path(os.environ.get('PLV4_FIXTURE_ROOT', str(Path(tempfile.gettempdir()) / "xyz-plv4-p2-comfy")))


def prepare():
    wrapper = SCRATCH / "custom_nodes" / "plv4_fixture"
    wrapper.mkdir(parents=True, exist_ok=True)
    for name in ("user", "input", "output", "temp", "models"):
        (SCRATCH / name).mkdir(exist_ok=True)
    (wrapper / "__init__.py").write_text(
        f"import runpy\nglobals().update(runpy.run_path({str(Path(__file__).resolve())!r}, run_name='comfy_fixture'))\n",
        encoding="utf-8",
    )
    web = wrapper / "js"
    web.mkdir(exist_ok=True)
    for name in ("plv3.js", "plv4.js", "gallery_topbar.js", "xyz_topbar.js", "tagac.js", "tagac_host.js", "lora_completion.js", "xyz_settings.js", "tagdb_panel.js"):
        shutil.copy2(REPO / "js" / name, web / name)
    for name in ("plv3", "plv4", "prompt_shared"):
        shutil.copytree(REPO / "js" / name, web / name, dirs_exist_ok=True)
    print(SCRATCH)


if __name__ == "__main__":
    prepare()
else:
    sys.path.insert(0, str(REPO))
    from prompt_library_v3.node import PromptLibraryV3Node, PromptLibraryV3MonacoNode
    from prompt_library_v4.node import PromptLibraryV4Node, PromptLibraryV4MonacoNode
    from server import PromptServer
    from aiohttp import web

    from prompt_library_v4.setup import setup as setup_v4
    import folder_paths
    models = SCRATCH / 'models' / 'loras' / 'characters'
    models.mkdir(parents=True, exist_ok=True)
    (models / 'Native Demo.safetensors').write_bytes(b'fixture only')
    folder_paths.folder_names_and_paths['loras'] = ([str(models.parent)], {'.safetensors'})
    setup_v4(PromptServer.instance, SCRATCH / 'v4_library.db')

    @PromptServer.instance.routes.get('/xyz/tagac/settings')
    async def tag_settings(request):
        return web.json_response({"enabled": False})

    @PromptServer.instance.routes.get('/xyz/tagdb/search')
    async def tag_search(request):
        query = request.query.get('q', '').replace('_', ' ').lower()
        tags = [{'name': 'blue_eyes', 'category': 0, 'post_count': 1000,
                 'sources': ['danbooru', 'gelbooru'], 'aliases': ['fixture alias']}]
        return web.json_response([tag for tag in tags if query in tag['name'].replace('_', ' ')])

    class Capture:
        CATEGORY = 'PLv4 Fixture'
        FUNCTION = 'execute'
        RETURN_TYPES = ()
        OUTPUT_NODE = True

        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {"prompt": ("STRING",), "plain": ("STRING",)}}

        def execute(self, prompt, plain):
            return {"ui": {"prompt": [prompt], "plain": [plain]}}

    class Resolution:
        CATEGORY = 'PLv4 Fixture'
        FUNCTION = 'execute'
        RETURN_TYPES = ('INT', 'INT')
        RETURN_NAMES = ('width', 'height')

        @classmethod
        def INPUT_TYPES(cls):
            return {'required': {}}

        def execute(self):
            return 1024, 768

    NODE_CLASS_MAPPINGS = {
        'XYZ Prompt Library V3': PromptLibraryV3Node,
        'XYZ Prompt Library V3 Monaco': PromptLibraryV3MonacoNode,
        'XYZ Prompt Library V4': PromptLibraryV4Node,
        'XYZ Prompt Library V4 Monaco': PromptLibraryV4MonacoNode,
        'PLv4 Fixture Capture': Capture,
        'PLv4 Fixture Resolution': Resolution,
    }
    NODE_DISPLAY_NAME_MAPPINGS = {name: name for name in NODE_CLASS_MAPPINGS}
    WEB_DIRECTORY = str(SCRATCH / "custom_nodes" / "plv4_fixture" / "js")
