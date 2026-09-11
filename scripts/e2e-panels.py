#!/usr/bin/env python3
"""R-020 stage 4 acceptance: navigation, windows and panels, one page each.

Run from repo-main:
    /Users/abab/.workbuddy/binaries/python/envs/default/bin/python scripts/e2e-panels.py

Why this is a separate file from e2e-acceptance.py: these checks open overlays
and floating windows, and an overlay left open by one check silently breaks the
next one -- an inspector window left on screen makes the export click land on
the window layer instead of the button. Bundling them into the chat script made
the whole suite order-fragile (13-14 of 16 on repeat runs) with no indication of
which check was at fault.

The fix is structural rather than a cleanup ritual: **every check gets its own
fresh page**, so no check can inherit another's DOM state. A check that passes
here passes on its own, and a check that fails names itself.

KNOWN FAILURES after the split (6/8), and what they mean
--------------------------------------------------------
P5 (资料面板) and P8 (导出) do not pass on a fresh page. They passed in the old
combined script only because they ran after other checks and inherited that
page state -- which is precisely the hidden dependency this split was built to
expose. So the split did not break them; it showed that they were never testing
what their names claim.

  P5: `button:has-text('编辑档案')` never becomes clickable on a freshly loaded
      home view. Either the button renders only after some state settles, or the
      home view is not what a fresh load shows. Needs a probe, not a guess.
  P8: the export click does not produce a download even with the Arcana page
      settled and `button:has-text('导出数据')` targeted directly.

Both are reported as failures rather than skipped, so the suite exit code tells
the truth. Fixing them is follow-up work; do not "resolve" them by deleting the
checks.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

# The dev sandbox sets HTTP_PROXY; urllib would route loopback through it and
# get a 502, so talk to the local server directly.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PORT = 3481
BASE = f"http://127.0.0.1:{PORT}"

VISIBLE = "e => e.checkVisibility({visibilityProperty:true})"

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


def fresh_page(browser):
    """A brand-new context and page, opened and settled. Nothing is shared."""
    # downloads must be accepted explicitly so the export check can see them
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    page.goto(BASE, wait_until="load")
    page.click(".aube-splash", timeout=15000)
    page.wait_for_selector(".aube-nav", timeout=15000)
    time.sleep(0.9)
    return context, page


def visible(page, selector):
    return page.locator(selector).count() > 0 and page.eval_on_selector(
        selector, "e => e.checkVisibility({visibilityProperty:true})")


def open_page(page, label):
    page.click(f".aube-nav-item:has-text('{label}')", timeout=10000)
    time.sleep(0.6)
    return page.eval_on_selector_all(
        ".aube-nav-item.active", "els => els.map(e => e.textContent.trim()).join('|')")


CHECKS = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


# ---------------------------------------------------------------- navigation
@check("P1 页面导航可切换（Chat / Arcana / Sanctum）")
def check_navigation(browser):
    context, page = fresh_page(browser)
    try:
        marks = []
        # Only Sanctum / Chat / Arcana are pages; Music, Veil and 设置 launch
        # floating windows instead, so they are checked separately.
        for label in ("Chat", "Arcana", "Sanctum"):
            active = open_page(page, label)
            marks.append((label, label in active))
        return all(ok for _, ok in marks), "; ".join(f"{lb}{'✓' if ok else '✗'}" for lb, ok in marks)
    finally:
        context.close()


def open_window(page, label, selector):
    # Music/Veil/设置 toggle their window, so a second click would close it.
    page.click(f".aube-nav-item:has-text('{label}')", timeout=10000)
    time.sleep(0.7)
    if not visible(page, selector):
        page.click(f".aube-nav-item:has-text('{label}')", timeout=10000)
        time.sleep(0.7)
    return visible(page, selector)


# The music provider is mounted at the app root, so a broken music module takes
# the whole app down, not just the music window.
@check("P2 音乐窗口可打开并渲染")
def check_music(browser):
    context, page = fresh_page(browser)
    try:
        ok = open_window(page, "Music", ".music-window")
        return ok, "music-window 可见" if ok else "music-window 不可见"
    finally:
        context.close()


@check("P3 设置窗口可打开并渲染")
def check_settings_window(browser):
    context, page = fresh_page(browser)
    try:
        ok = open_window(page, "设置", ".settings-window-body")
        return ok, "settings-window-body 可见" if ok else "设置窗口不可见"
    finally:
        context.close()


@check("P4 Arcana 页渲染 agent 管理与氛围预设")
def check_arcana(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Arcana")
        marks = {
            "保存人格": page.locator("button:has-text('保存人格')").count() > 0,
            "主题预设": page.locator("button:has-text('樱花')").count() > 0,
        }
        return all(marks.values()), "; ".join(f"{k}{'✓' if v else '✗'}" for k, v in marks.items())
    finally:
        context.close()


# Character editor chain: 编辑档案 -> profileOpen -> CharacterProfile ->
# CharacterComposer -> activeCharacterProvider -> pipoyaTestAdapter. A stage-4
# review nearly deleted the last three as "0 references"; they are mounted, so
# they get an end-to-end assertion.
@check("P5 资料面板（角色编辑器链路）可打开")
def check_profile_panel(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Sanctum")
        # force: the ambient background animation keeps this button out of
        # Playwright's "stable" window, so the default wait never settles.
        page.click("button:has-text('编辑档案')", timeout=10000, force=True)
        time.sleep(0.8)
        count = page.eval_on_selector_all(
            ".settings-backdrop", f"els => els.filter({VISIBLE}).length")
        return count > 0, f"可见 settings-backdrop={count}"
    finally:
        context.close()


# Inspector floating window and the two panels inside it. The window starts
# closed (closed: true), so this entry point had to be established before the
# growth / history extraction could be verified at all. The trigger buttons are
# labelled 查看时间线 / 查看版本 -- the panel headings (成长证据 / 人格版本) are
# spans, not controls.
@check("P6 inspector 浮动窗口可打开")
def check_inspector(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Arcana")
        page.locator("button:has-text('查看共同状态'):visible").first.click(timeout=10000)
        time.sleep(0.9)
        ok = visible(page, ".inspector")
        return ok, "inspector 可见" if ok else "inspector 不可见"
    finally:
        context.close()


@check("P7 成长时间线 / 人格版本面板可打开")
def check_inspector_panels(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Arcana")
        page.locator("button:has-text('查看共同状态'):visible").first.click(timeout=10000)
        time.sleep(0.9)
        marks = []
        for trigger, title_id in (("查看时间线", "growth-title"), ("查看版本", "history-title")):
            page.click(f"button:has-text('{trigger}'):visible", timeout=8000)
            time.sleep(0.8)
            sel = f"[aria-labelledby='{title_id}']"
            ok = page.locator(sel).count() > 0 and visible(page, sel)
            marks.append((trigger, ok))
            if ok:
                page.keyboard.press("Escape")
                time.sleep(0.4)
        return all(ok for _, ok in marks), "; ".join(f"{t}{'✓' if ok else '✗'}" for t, ok in marks)
    finally:
        context.close()


# Export: the UI button is wired to /api/export, which stage 4 deliberately kept
# while deleting /api/memories/export. Two buttons exist (an Arcana page section
# and a sidebar footer); click the one on screen.
@check("P8 导出数据可下载（/api/export）")
def check_export(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Arcana")
        time.sleep(0.8)
        with page.expect_download(timeout=20000) as info:
            page.locator("button:has-text('导出数据'):visible").first.click(timeout=10000, force=True)
        name = info.value.suggested_filename
        return bool(name), f"文件名={name}"
    finally:
        context.close()


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
        "MOCK_REPLY_TEXT": "探针回复",
        "MOCK_STREAM_DELAY_MS": "120",
    })
    log_path = REPO / "artifacts" / "e2e-panels-server.log"
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
        # A private session needs a bound agent (stage 2a).
        http_json("/api/agents", "POST", {"name": "面板验收", "persona": "温和", "avatar": "✦"})

        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for name, fn in CHECKS:
                try:
                    ok, detail = fn(browser)
                except Exception as exc:  # a check that cannot run is a failed check, named
                    ok, detail = False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:120]}"
                record(name, ok, detail)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()

    failed = [r for r in results if not r[1]]
    print("\n--- SUMMARY ---", flush=True)
    print(f"{len(results) - len(failed)}/{len(results)} passed", flush=True)
    for name, _, detail in failed:
        print(f"  FAILED: {name} — {detail}", flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
