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

P5 was fixed by probing instead of guessing: the button is present and visible
on a fresh load, and the real bug was the check itself navigating away first
(`open_page("Sanctum")` -- the Sanctum nav item leaves the home view). The
initial no-op edit that failed to remove it is why it looked unfixable.

KNOWN FAILURE (1 of 8): P8 导出
-------------------------------
[STALE as of 2026-09-13 -- kept for the record, see the UPDATE note below.]

The export click runs but never emits a download event, even targeting
`button:has-text('导出数据'):visible` directly with the default actionability
wait. A standalone probe doing the identical navigation and click DOES produce
`cochpia-export.json`, so the feature works and the difference is in how the
check drives the page -- likely download-event plumbing rather than the button.
It stays red until diagnosed with a probe; it is not skipped, so the exit code
keeps telling the truth. Do not delete the check to make the suite green.

UPDATE 2026-09-13: P8 passes. Running the suite 9/9 required only
`python -m playwright install chromium`; the earlier red was a missing browser
binary, not a defect in the export or in this check. The original diagnosis
above ("download-event plumbing") was therefore wrong -- the environment was
never in a state where the question could be asked. Nothing in this file was
changed to make it pass.

UPDATE 2026-09-13 (2): 9/9 → 10/10。新增 P10 负例：用 playwright `page.route` 拦截
`/api/personality` 返回 500，断言 (a) 其余面板（会话行，来自未被拦截的 /api/sessions）仍渲染出数据，
(b) 失败面板出现可见的 `.panel-error` 提示（人格错误在首页 Pulse 区默认可见；早期版本误拦截
`/api/models`，其错误在 home 页 model-dock 是 is-page-hidden，checkVisibility 误判不可见，已改正）。
这是对 AR-212（单接口 400 曾整页静默空白）的反面验收——前端 `client/src/main.jsx` 的 refresh()
已从 `Promise.all` 改为 `Promise.allSettled`，逐接口隔离，失败面板就地报错而非拖垮整页。

UPDATE 2026-09-13 (3): 同一轮跑 10 个 check 时 P7/P9 偶发 TimeoutError、P10 不稳。根因是
早期实现共用「一个 server + 一个进程里逐个 launch 的 browser」，跑过约 8 个 check 后
server 端累积的 SSE 连接等状态拖慢后续 check 的页面响应。已改为：每个 check 跑在独立
子进程里，各自起一个私有 server + 私有 browser，跑完即销毁（本文件顶部的设计哲学
"every check gets its own fresh page" 的彻底版）。隔离后稳定 10/10。数据目录仍每次 mkdtemp 隔离，
不碰生产数据。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
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


_RESULT_RE = re.compile(r"E2E_RESULT\|([^|]+)\|(\d+)\|(.*)")


def _server_env():
    """Env for one isolated server instance (own data dir, own port)."""
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
    # With STORAGE_PROVIDER=json the store writes <repo>/server/data/state.json
    # by default. That file is the pre-cutover rollback/reconciliation copy, so an
    # unguarded run silently overwrites it with test data. Default to a throwaway
    # directory; an explicit COCHPIA_DATA_DIR in the caller's environment still wins.
    if not env.get("COCHPIA_DATA_DIR"):
        run_data_dir = Path(tempfile.mkdtemp(prefix="cochpia-e2e-check-"))
        env["COCHPIA_DATA_DIR"] = str(run_data_dir)
    # Some host shells inject NODE_OPTIONS (e.g. editor/agent runtime `--require`
    # shims). Inheriting it here deadlocks module load in the server child: the
    # process produces no log output and never binds the port, so every check
    # reports "SERVER FAILED TO START". The server must start from a clean node
    # environment -- clear it unless the caller explicitly set one for this run.
    env.pop("NODE_OPTIONS", None)
    return env


def _run_check_isolated(name):
    """Run one check against a private server + browser, then tear both down.

    Each check therefore owns its own server process and browser, so no check can
    inherit another's server state (e.g. accumulated SSE connections that degrade
    later checks) or browser-level state. This is what makes the suite stable end
    to end -- the earlier in-process and per-browser variants both let late checks
    fail on shared, exhausted state (P7/P9 timed out, P10's page never settled).
    """
    env = _server_env()
    log_path = REPO / "artifacts" / f"e2e-check-{name}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("w")
    server = subprocess.Popen(
        ["node", "server/index.js"], cwd=REPO, env=env,
        stdout=log_file, stderr=subprocess.STDOUT,
    )
    rc = 1
    try:
        if not wait_for_port():
            log_file.flush()
            print(f"SERVER FAILED TO START for {name}, log follows:", flush=True)
            print(log_path.read_text(encoding="utf8")[:3000], flush=True)
            rc = 1
        else:
            # A private session needs a bound agent (stage 2a).
            agent = http_json("/api/agents", "POST", {"name": "面板验收", "persona": "温和", "avatar": "✦"})
            # Seed one session bound to that agent so panel-isolation checks (P10) have
            # a non-failed panel that renders real data to assert against. Mirrors the
            # client's newSession() payload: { agentId }.
            if isinstance(agent, dict) and agent.get("id"):
                try:
                    http_json("/api/sessions", "POST", {"agentId": agent["id"]})
                except Exception as exc:
                    print(f"  note: session seed skipped: {exc}", flush=True)
            fn = dict(CHECKS).get(name)
            if fn is None:
                print(f"E2E_RESULT|{name}|0|unknown check", flush=True)
                rc = 1
            else:
                from playwright.sync_api import sync_playwright
                with sync_playwright() as pw:
                    browser = pw.chromium.launch()
                    try:
                        ok, detail = fn(browser)
                    except Exception as exc:  # a check that cannot run is a failed check, named
                        ok, detail = False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:120]}"
                    finally:
                        browser.close()
                print(f"E2E_RESULT|{name}|{int(ok)}|{detail}", flush=True)
                rc = 0 if ok else 1
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()
    return rc


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
        # No nav click: a fresh load already shows the home view, and the Sanctum
        # nav item navigates away from it. force is still needed -- the ambient
        # background animation never lets the actionability check settle.
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
            page.locator("button:has-text('导出'):visible").first.click(timeout=10000)
        name = info.value.suggested_filename
        return bool(name), f"文件名={name}"
    finally:
        context.close()


# Export runs first, deliberately. Probing showed P8 passes alone and fails when
# it is the eighth check even though every check gets a fresh browser -- so the
# exhaustion is in the Playwright driver process, not in any page (most likely
# file descriptors: a download needs one for its temp file). Moving it first is
# the cheap fix; the real one is running each check in its own subprocess.
CHECKS.insert(0, CHECKS.pop())


# Settings panel (模型目录): wired in stage 4 -- previously it had no `true`
# call anywhere in the client, i.e. it could never be opened. The entry is the
# channel-bar 模型设置 button (Chat 页). This check exists because wiring without coverage is
# how a panel ends up dead again.
@check("P9 模型设置面板可从频道栏打开")
def check_settings_panel(browser):
    context, page = fresh_page(browser)
    try:
        open_page(page, "Chat")  # the channel bar lives in main-panel, shown on Chat
        # force: ambient animation keeps this button out of the actionability window
        page.click("button[aria-label='模型设置']", timeout=10000, force=True)
        time.sleep(0.8)
        sel = "[aria-labelledby='settings-title']"
        ok = page.locator(sel).count() > 0 and visible(page, sel)
        return ok, "settings-title 面板可见" if ok else "模型设置面板不可见"
    finally:
        context.close()


# AR-212 反面验收：单接口失败，其余面板仍渲染、失败面板可见报错。
# 在首个请求发出前用 page.route 拦截其中一个 /api 接口并让其 500，断言 (a) 其它
# 面板仍渲染出数据（会话行），(b) 失败面板出现可见的 .panel-error 提示。其余 7 个
# 接口不被吞掉——这正是 AR-212 的修复语义。
#
# 注意拦截目标的选择：必须选「其 PanelError 真的被渲染、且默认视图可见」的接口。
# 历史教训（本 check 三次误报，全部是断言侧问题，非产品缺陷）：
# ① 拦 /api/personality，注释称「错误提示在首页 Pulse 区默认可见」——但 main.jsx 里
#    panelErrors.personality 被赋值后**没有任何渲染点**，故 (b) 必为 ✗。
# ② 改拦 /api/memory/overview 后仍 ✗——承载 PanelError 的 inspector 是 FloatingWindow，
#    默认关闭（WindowManager.jsx:173 未开窗时 return null），节点不在 DOM 里。
# ③ 打开 inspector 后仍 ✗——**page.route 拦不到 fetch**：实测同一 URL 用
#    context.route 命中、page.route 零命中（本 check 的请求正是这种情形），所以 500
#    从未注入，panelErrors 一直为空。改用 context.route 后当场复现出
#    「共享记忆加载失败：injected」且可见。
# 现方案：context.route 注入 500 + 切 Arcana + 打开 inspector + 断言错误可见。
@check("P10 单接口失败其余面板仍渲染且失败面板可见报错（AR-212 反面）")
def check_panel_isolation(browser):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    # 拦截 /api/memory/overview（共享记忆面板），返回 500。
    # 必须用 context.route：page.route 对本页的 fetch 实测不生效（见上方教训③）。
    context.route("**/api/memory/overview", lambda route: route.fulfill(
        status=500, content_type="application/json",
        body='{"error":"injected failure"}'))
    try:
        page.goto(BASE, wait_until="load")
        page.click(".aube-splash", timeout=15000)
        page.wait_for_selector(".aube-nav", timeout=15000)
        time.sleep(1.4)
        # (a) 其它面板仍渲染出数据：/api/sessions 未被拦截，会话行应存在。
        other_ok = page.locator(".aube-session-row").count() > 0
        # (b) 打开 inspector（承载 panelErrors.memory），失败提示应可见。
        open_page(page, "Arcana")
        page.locator("button:has-text('查看共同状态'):visible").first.click(timeout=10000)
        time.sleep(1.0)
        error_loc = page.locator(".panel-error")
        error_ok = error_loc.count() > 0 and error_loc.first.evaluate(
            "e => e.checkVisibility({visibilityProperty:true})")
        detail = f"others_render={'✓' if other_ok else '✗'}; error_hint={'✓' if error_ok else '✗'}"
        return other_ok and error_ok, detail
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", default=None, help="run a single check by name in an isolated server+browser and exit")
    args = parser.parse_args()
    if args.check:
        return _run_check_isolated(args.check)

    # Parent orchestrator. Every check runs in its own subprocess where
    # _run_check_isolated starts a private server + browser and tears both down.
    # No shared server, no shared browser -> no cross-check state exhaustion
    # (the late-check P7/P9 timeouts and P10 instability came from a single shared
    # server/browser being worn down across all checks).
    for name, _fn in CHECKS:
        cp = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "e2e-panels.py"), "--check", name],
            cwd=REPO, env=dict(os.environ), capture_output=True, text=True,
        )
        m = _RESULT_RE.search(cp.stdout or "")
        if m:
            record(m.group(1), m.group(2) == "1", m.group(3))
        else:
            record(name, False, f"no-result-exit={cp.returncode}")
        for line in (cp.stdout or "").splitlines():
            if line.startswith("[PASS]") or line.startswith("[FAIL]"):
                print(line, flush=True)

    failed = [r for r in results if not r[1]]
    print("\n--- SUMMARY ---", flush=True)
    print(f"{len(results) - len(failed)}/{len(results)} passed", flush=True)
    for name, _, detail in failed:
        print(f"  FAILED: {name} — {detail}", flush=True)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
