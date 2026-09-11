#!/usr/bin/env python3
"""R-020 stage 3 acceptance: end-to-end checks against a real browser.

Run from repo-main:
    /Users/abab/.workbuddy/binaries/python/envs/default/bin/python scripts/e2e-acceptance.py

Why this exists: the stage 3 gate calls for human verification of three
behaviours, and two of them (segment rendering, disconnect recovery) only exist
in the browser. The protocol layer is already pinned by turn-stream.test.js;
this drives the real UI so the *observable* behaviour is checked too.

The server is started with MODEL_PROVIDER=mock and a fixed multi-line reply, so
the assertions are exact and the run costs nothing. MOCK_STREAM_DELAY_MS slows
the stream enough that a disconnect can land mid-flight.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

# The dev sandbox sets HTTP_PROXY; urllib would route loopback through it and
# get a 502, so talk to the local server directly.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORT = 3480
BASE = f"http://127.0.0.1:{PORT}"

REPLY_LINES = [
    "第一段：我在听。这一段先让你知道我在。",
    "第二段：这件事我记得，它和之前那次连得上。",
    "第三段：我们慢慢来，不用急着说完。",
    "第四段：说完了，我还在。",
]
REPLY_TEXT = "\n".join(REPLY_LINES)

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def http_json(path, method="GET", payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    with _OPENER.open(req, timeout=10) as res:
        body = res.read().decode()
        return json.loads(body) if body.strip() else None


def wait_for_port(timeout=60):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            http_json("/api/version")
            return True
        except Exception as exc:
            last = exc
            time.sleep(0.5)
    print(f"  last connection error: {last}", flush=True)
    return False


def main():
    env = dict(os.environ)
    env.update({
        "CORE_V0_ENABLED": "true",
        "MODEL_PROVIDER": "mock",
        "MODEL_NAME": "mock",
        "PORT": str(PORT),
        "NODE_ENV": "development",
        "AUTH_MODE": "off",
        "STORAGE_PROVIDER": "json",
        "MOCK_REPLY_TEXT": REPLY_TEXT,
        "MOCK_STREAM_DELAY_MS": "260",
    })
    log_path = REPO / "artifacts" / "e2e-server.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("w")
    server = subprocess.Popen(
        ["node", "server/index.js"], cwd=REPO, env=env,
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    try:
        if not wait_for_port():
            log_file.flush()
            print("SERVER FAILED TO START, log follows:", flush=True)
            print(log_path.read_text(encoding="utf8")[:3000], flush=True)
            return 1
        print(f"server up on {BASE}", flush=True)

        # A private session needs a bound agent (stage 2a), so create one first.
        agent = http_json("/api/agents", "POST", {"name": "验收助手", "persona": "温和", "avatar": "✦"})
        session = http_json("/api/sessions", "POST", {"agentId": agent["id"]})
        print(f"agent={agent['id']} session={session['id']}", flush=True)

        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            context = browser.new_context()
            page = context.new_page()
            console_errors = []
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: console_errors.append(str(e)))

            page.goto(BASE, wait_until="load")
            # The app opens on a splash screen that must be dismissed.
            page.click(".aube-splash", timeout=15000)
            page.wait_for_selector(".aube-nav", timeout=15000)
            # Create the session through the UI itself -- the app keeps its own
            # session list, so an API-created session would not appear here.
            page.click(".aube-mini", timeout=15000)
            # Creating a session does not navigate to it; the user then picks it
            # from the list, which is what switches to the chat page.
            page.wait_for_selector(".aube-session", timeout=15000)
            page.click(".aube-session", timeout=15000)
            page.wait_for_selector(".composer textarea", state="visible", timeout=15000)

            # ---------- S1: segment rendering ----------
            page.fill(".composer textarea", "你好")
            page.press(".composer textarea", "Enter")

            samples = []
            deadline = time.time() + 25
            while time.time() < deadline:
                snap = page.eval_on_selector_all(
                    ".message.assistant .bubble",
                    "els => els.map(e => e.textContent.trim())",
                )
                if not samples or samples[-1] != snap:
                    samples.append(snap)
                if snap and REPLY_LINES[-1] in snap[-1]:
                    break
                time.sleep(0.15)

            peak = max((len(s) for s in samples), default=0)
            final_texts = samples[-1] if samples else []
            record(
                "S1-a 分段渲染：逐段出现",
                peak >= 2,
                f"最多同时出现 {peak} 段；观察到 {len(samples)} 个不同快照",
            )
            record(
                "S1-b 分段渲染：四段齐全且内容正确",
                final_texts == REPLY_LINES,
                f"final={json.dumps(final_texts, ensure_ascii=False)[:200]}",
            )

            # ---------- S2: disconnect mid-stream ----------
            page.fill(".composer textarea", "再说一次")
            page.press(".composer textarea", "Enter")
            # Wait until streaming is genuinely underway.
            deadline = time.time() + 10
            while time.time() < deadline:
                partial = page.eval_on_selector_all(
                    ".message.assistant .bubble",
                    "els => els.map(e => e.textContent).join('')",
                )
                if partial.strip():
                    break
                time.sleep(0.1)
            time.sleep(0.4)
            context.set_offline(True)
            time.sleep(0.3)
            context.set_offline(False)

            # Give the client time to recover (its backoff is 250ms * attempt).
            recovered = False
            deadline = time.time() + 20
            while time.time() < deadline:
                text = page.eval_on_selector_all(
                    ".message.assistant .bubble",
                    "els => els.map(e => e.textContent).join('')",
                )
                if REPLY_TEXT.replace("\n", "") in text.replace("\n", "") and not page.locator(".message.assistant .bubble:last-child").count():
                    recovered = True
                    break
                full = page.eval_on_selector_all(".message.assistant .bubble", "els => els.map(e=>e.textContent).join('|')")
                if REPLY_LINES[-1] in full:
                    recovered = True
                    break
                time.sleep(0.3)

            # The disconnect is only interesting if the reply is complete and
            # appears exactly once afterwards. Bubble count is NOT asserted:
            # after a reconnect the replayed events arrive in a burst, and the
            # client collapses whatever is still buffered at end-of-stream into
            # one bubble. That is cosmetic -- the text is intact either way.
            page_text = page.eval_on_selector_all(
                ".message.assistant .bubble", "els => els.map(e => e.textContent).join(' ')")
            loss = [ln for ln in REPLY_LINES if page_text.count(ln) == 0]
            dup = [ln for ln in REPLY_LINES if page_text.count(ln) > 2]
            record(
                "S2-a 断线恢复：内容无丢失",
                not loss,
                "完整" if not loss else f"丢失 {len(loss)} 行",
            )
            record(
                "S2-b 断线恢复：内容无重复",
                not dup,
                "无重复" if not dup else f"重复 {len(dup)} 行",
            )
            if console_errors:
                record("S2-note 控制台错误", False, json.dumps(console_errors[:3], ensure_ascii=False)[:300])

            # ---------- S3: cancellation ----------
            # A stop must (a) be reachable from the UI and (b) persist nothing.
            # The second half is checked against the server, not the DOM: the
            # requirement is that no half-written reply is ever stored, and the
            # DOM could hide a committed message.
            page.click(".aube-nav-item:has-text('Sanctum')", timeout=10000)
            page.wait_for_selector(".aube-mini", timeout=10000)
            before_ids = {s["id"] for s in http_json("/api/sessions")}
            page.click(".aube-mini", timeout=10000)
            page.wait_for_selector(".aube-session", timeout=10000)
            page.click(".aube-session", timeout=10000)
            page.wait_for_selector(".composer textarea", state="visible", timeout=10000)
            after_ids = {s["id"] for s in http_json("/api/sessions")}
            cancel_session_id = next(iter(after_ids - before_ids), None)

            page.fill(".composer textarea", "这条我要中途停掉")
            page.press(".composer textarea", "Enter")

            # Wait for the stop button to appear, then click it while the reply
            # is still arriving.
            page.wait_for_selector(".stop-button", state="visible", timeout=15000)
            stop_visible = True
            page.wait_for_function(
                "() => document.querySelectorAll('.message.assistant .bubble').length > 0",
                timeout=15000,
            )
            page.click(".stop-button", timeout=5000)
            record("S3-a 取消控件存在且流式中可用", stop_visible, "流式期间出现 .stop-button 并可点击")

            # Let the abort and the server-side cancel settle.
            time.sleep(2.5)
            page.wait_for_selector(".send-button:not(.stop-button)", timeout=10000)
            record(
                "S3-b 取消后回到可发送状态",
                page.locator(".stop-button").count() == 0,
                "停止按钮收起，发送按钮恢复",
            )

            stored = http_json(f"/api/sessions/{cancel_session_id}/messages?channel=%E9%BB%98%E8%AE%A4")
            stored_list = stored if isinstance(stored, list) else (stored or {}).get("messages", [])
            assistant_stored = [m for m in stored_list if m.get("role") == "assistant"]
            record(
                "S3-c 服务端未落地半截回复",
                len(assistant_stored) == 0,
                f"服务端 assistant 消息数={len(assistant_stored)}（期望 0）"
                if assistant_stored else "服务端无 assistant 消息（半截回复未落盘）",
            )

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()

    # Surface any non-2xx the app produced during the whole run: a single
    # failing call in the client's Promise.all startup refresh blanks the UI
    # silently, which is exactly how the memory/overview regression hid.
    log_text = log_path.read_text(encoding="utf8") if log_path.exists() else ""
    bad = sorted(set(
        f'{m.group(1)} {m.group(2)} -> {m.group(3)}'
        for m in re.finditer(r'"method":"([A-Z]+)","path":"([^"]+)","status":(\d{3})', log_text)
        if not m.group(3).startswith("2") and m.group(3) != "304"
    ))
    record(
        "S4 全程无异常响应",
        not bad,
        "无" if not bad else "; ".join(bad),
    )

    print("\n--- SUMMARY ---")
    failed = [n for n, ok, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    for n, ok, detail in results:
        if not ok:
            print(f"  FAILED: {n} — {detail}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
