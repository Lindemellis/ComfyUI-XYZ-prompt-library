"""LLM multi-provider — Anthropic adapter conversion + settings provider model."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import llm.client as client
import llm.settings as settings


def test_anthropic_adapter():
    captured = {}

    def fake_post(url, headers, payload, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["payload"] = payload
        # simulate an Anthropic response with text + a tool_use block
        return {
            "model": "claude-opus-4-1",
            "stop_reason": "tool_use",
            "content": [
                {"type": "text", "text": "Let me look that up."},
                {"type": "tool_use", "id": "tu_1", "name": "lookup_danbooru_tags",
                 "input": {"queries": ["twintails"]}},
            ],
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }

    client._post = fake_post

    cfg = {"kind": "anthropic", "api_key": "sk-ant-xxx", "base_url": "https://api.anthropic.com",
           "model": "claude-opus-4-1", "temperature": 0.7, "top_p": 0.9}
    messages = [
        {"role": "system", "content": "You are a tagger."},
        {"role": "user", "content": "draw amiya"},
        {"role": "assistant", "content": "",
         "tool_calls": [{"id": "tu_0", "type": "function",
                         "function": {"name": "lookup_danbooru_tags", "arguments": '{"queries":["amiya"]}'}}]},
        {"role": "tool", "tool_call_id": "tu_0", "content": '[{"name":"amiya_(arknights)"}]'},
    ]
    tools = [{"type": "function", "function": {"name": "lookup_danbooru_tags",
              "description": "search", "parameters": {"type": "object", "properties": {}}}}]

    out = client.complete(cfg, messages, tools=tools)

    p = captured["payload"]
    # endpoint + headers
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["x-api-key"] == "sk-ant-xxx"
    assert captured["headers"]["anthropic-version"]
    # system extracted out of messages
    assert p["system"] == "You are a tagger."
    assert "max_tokens" in p
    # tools converted to input_schema
    assert p["tools"][0]["name"] == "lookup_danbooru_tags"
    assert "input_schema" in p["tools"][0]
    # message conversion: user, assistant(tool_use), user(tool_result)
    roles = [m["role"] for m in p["messages"]]
    assert roles == ["user", "assistant", "user"], roles
    assert p["messages"][1]["content"][-1]["type"] == "tool_use"
    assert p["messages"][2]["content"][0]["type"] == "tool_result"
    assert p["messages"][2]["content"][0]["tool_use_id"] == "tu_0"
    # response normalized back to OpenAI shape
    assert out["message"]["content"] == "Let me look that up."
    assert out["message"]["tool_calls"][0]["function"]["name"] == "lookup_danbooru_tags"
    assert json.loads(out["message"]["tool_calls"][0]["function"]["arguments"])["queries"] == ["twintails"]
    assert out["usage"]["total_tokens"] == 120
    print("ok: anthropic adapter in/out conversion")


def test_settings_multiprovider():
    tmp = tempfile.mkdtemp(prefix="llm_mp_")
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"

    pub = settings.public()
    assert pub["provider"] == "deepseek"
    assert set(pub["providers"]) == {"deepseek", "openai", "anthropic", "xai", "custom"}

    # set the anthropic key + switch provider
    settings.update({"provider_update": {"id": "anthropic", "api_key": "sk-ant-1234567890"}})
    settings.update({"provider": "anthropic"})
    pc = settings.active_provider_config()
    assert pc["provider"] == "anthropic" and pc["kind"] == "anthropic"
    assert pc["api_key"] == "sk-ant-1234567890"
    assert pc["base_url"] == "https://api.anthropic.com"
    assert pc["model"] == "claude-opus-4-1"  # first preset model

    # custom provider with a kind override
    settings.update({"provider_update": {"id": "custom", "api_key": "k", "base_url": "http://localhost:1234/v1",
                                          "model": "local-model", "kind": "openai"}})
    settings.update({"provider": "custom"})
    pc = settings.active_provider_config()
    assert pc["kind"] == "openai" and pc["base_url"] == "http://localhost:1234/v1" and pc["model"] == "local-model"

    # switching back keeps the anthropic key (per-provider storage)
    settings.update({"provider": "anthropic"})
    assert settings.active_provider_config()["api_key"] == "sk-ant-1234567890"

    # mask sentinel keeps key
    settings.update({"provider_update": {"id": "anthropic", "api_key": settings.MASK_SENTINEL, "model": "claude-sonnet-4-5"}})
    pc = settings.active_provider_config()
    assert pc["api_key"] == "sk-ant-1234567890" and pc["model"] == "claude-sonnet-4-5"

    # masked in public
    assert settings.public()["providers"]["anthropic"]["api_key_masked"].startswith("sk-")
    print("ok: multi-provider settings (switch / per-provider keys / custom kind / mask)")


def test_legacy_migration():
    tmp = tempfile.mkdtemp(prefix="llm_legacy_")
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"
    # write a legacy flat file
    Path(settings._SETTINGS_PATH).write_text(json.dumps({
        "api_key": "sk-legacy123", "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-pro", "temperature": 0.5, "seeded": True}), encoding="utf-8")
    pc = settings.active_provider_config()
    assert pc["provider"] == "deepseek" and pc["api_key"] == "sk-legacy123"
    assert pc["temperature"] == 0.5
    assert settings.is_seeded() is True
    print("ok: legacy flat settings migrate into providers.deepseek")


def main():
    test_anthropic_adapter()
    test_settings_multiprovider()
    test_legacy_migration()
    print("\nALL PROVIDER CHECKS PASSED")


if __name__ == "__main__":
    main()
