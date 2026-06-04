"""Manual live E2E: real DeepSeek call where the model spontaneously web-searches.

Uses the locally saved provider key. Only the web_search tool is exposed (tag lookup
off), so any grounding the model wants forces a real DuckDuckGo search. Prints the full
tool trace + final answer. Run: python -m test.manual.llm_websearch_live
"""
import io
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import llm.settings as settings
import llm.chat as chat
from llm import defaults as d

pcfg = settings.active_provider_config()
assert pcfg.get("api_key"), "no api key saved for the active provider"
print(f"== provider={pcfg['provider']} model={pcfg['model']} ==\n")

system = "\n\n".join([
    d.ANIMA_BLOCKS["header"],
    d.ANIMA_BLOCKS["web_search"],
    d.ANIMA_BLOCKS["format"],
])

user = (
    "我想画吉卜力 2023 年电影《你想活出怎样的人生》(The Boy and the Heron) 里的"
    "那只会说话的灰鹭/鹭男 (the grey heron man)。我不太确定他变成人形/半人形时的"
    "具体外观特征，请先查证一下他的样子，再给我写一段 anima 文生图提示词。"
)

messages = [
    {"role": "system", "content": system},
    {"role": "user", "content": user},
]

print("USER:", user, "\n")
print("...calling DeepSeek (web_search tool only)...\n")

res = chat.run_chat(pcfg, messages, enable_tools=False, enable_web_search=True)

trace = res.get("trace") or []
print(f"== tool calls: {len(trace)} (capped={res.get('capped')}) ==")
for i, t in enumerate(trace, 1):
    print(f"\n[{i}] {t['name']}  args={t.get('args')}")
    for r in (t.get("results") or [])[:5]:
        if r.get("_note"):
            print("     NOTE:", r["_note"])
        else:
            print(f"     - {r.get('title','')[:60]} | {r.get('url','')[:65]}")

print("\n== FINAL ANSWER ==")
print(res["message"].get("content", ""))
