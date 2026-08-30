"""Offline checks for the agent launcher's local-control boundary."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_nodes import launcher
from agent_nodes.routes import _local_only


class _Request:
    def __init__(self, remote: str | None):
        self.remote = remote


@pytest.mark.parametrize("remote", ["127.0.0.1", "::1", "localhost"])
def test_agent_routes_accept_loopback(remote: str) -> None:
    assert _local_only(_Request(remote)) is None


@pytest.mark.parametrize("remote", [None, "192.168.1.20", "8.8.8.8"])
def test_agent_routes_reject_non_loopback(remote: str | None) -> None:
    response = _local_only(_Request(remote))
    assert response is not None
    assert response.status == 403


def test_entry_must_be_dist_index(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "agent_data"
    monkeypatch.setattr(launcher, "DATA_DIR", data_dir)
    monkeypatch.setattr(launcher, "SETTINGS", data_dir / "settings.json")

    wrong = tmp_path / "run.js"
    wrong.write_text("", encoding="utf-8")
    with pytest.raises(launcher.OrchestratorNotFound):
        launcher.set_entry(str(wrong))

    entry = tmp_path / "orchestrator" / "dist" / "index.js"
    entry.parent.mkdir(parents=True)
    entry.write_text("", encoding="utf-8")
    assert launcher.set_entry(str(entry)) == str(entry.resolve())


def test_settings_cannot_inject_process_control_environment(
    monkeypatch, tmp_path: Path
) -> None:
    data_dir = tmp_path / "agent_data"
    data_dir.mkdir()
    settings = data_dir / "settings.json"
    settings.write_text(
        json.dumps({
            "env": {
                "NODE_OPTIONS": "--require=evil.js",
                "PATH": "C:/attacker",
                "PYTHONPATH": "C:/attacker",
                "LD_PRELOAD": "/tmp/evil.so",
                "COMFYUI_PATH": "C:/other-install",
                "COMFYUI_MCP_HOUSE_RULES_FILE": "C:/attacker/rules.md",
                "SAFE_PROVIDER_OPTION": "allowed",
            }
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(launcher, "DATA_DIR", data_dir)
    monkeypatch.setattr(launcher, "SETTINGS", settings)
    monkeypatch.setattr(launcher, "HOUSE_RULES_FILE", data_dir / "house_rules.md")
    monkeypatch.setattr(launcher, "ACTIVE_UNLOCK", data_dir / "unlock_active.md")
    monkeypatch.setattr(launcher, "UNLOCK_DIR", data_dir / "unlock")
    monkeypatch.setattr(launcher, "LEGACY_UNLOCK_FILE", data_dir / "unlock.md")
    monkeypatch.setattr(launcher, "PI_AUTH", tmp_path / "missing-auth.json")
    monkeypatch.delenv("NODE_OPTIONS", raising=False)
    monkeypatch.delenv("LD_PRELOAD", raising=False)
    original_path = launcher.os.environ.get("PATH")

    env = launcher._env_for_child()
    assert "NODE_OPTIONS" not in env
    assert "LD_PRELOAD" not in env
    assert env.get("PATH") == original_path
    assert env["COMFYUI_PATH"] != "C:/other-install"
    assert env.get("COMFYUI_MCP_HOUSE_RULES_FILE") != "C:/attacker/rules.md"
    assert env["SAFE_PROVIDER_OPTION"] == "allowed"
