"""Run the shared JavaScript history contract in the ordinary offline suite."""
from pathlib import Path
import shutil
import subprocess
import os
import sys
import pytest


@pytest.mark.parametrize('script', ['plv4_session_test.mjs', 'plv4_window_test.mjs', 'plv4_inline_session_test.mjs', 'plv4_details_test.mjs', 'plv4_text_input_test.mjs', 'plv4_prompt_text_test.mjs', 'plv4_text_editing_test.mjs', 'plv4_tagac_test.mjs', 'plv4_native_completion_test.mjs', 'plv4_library_test.mjs', 'plv4_drag_test.mjs', 'plv4_lora_test.mjs', 'plv3_retirement_test.mjs', 'canvas_performance_test.mjs'])
def test_document_session_history(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is unavailable")
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([node, "--test", str(root / 'test/js' / script)],
                            cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=30,
                            env={**os.environ, 'PLV4_TEST_PYTHON': sys.executable})
    assert result.returncode == 0, result.stdout + result.stderr
