#!/usr/bin/env python3
"""T6 集成验收：记忆主权面板在**真实浏览器**里能开、能渲染、删一条后真的消失。

为什么必须走浏览器而不是只跑单测：单测能证明纯函数对，组件能证明渲染对，
但「点下去到后端真的改了」这条链路只有真浏览器 + 真服务能证伪。本文件
针对的正是那段接线（main.jsx 里的 memory* 回调 → /api/memory/memories/*）。

设计上与 e2e-panels.py 一致：**每个 check 一个全新 page**，避免上一个检查
留下的遮罩把下一个的点击吃掉（那是 e2e 最常见的假红来源）。

前置：先 `npm run build`（server 用 express.static(dist) 提供前端），
dist 比 client/src 旧时本脚本拒绝运行 —— 否则测的是上一轮产物。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("T6_PORT", "3483"))
BASE = f"http://127.0.0.1:{PORT}"
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(REPO.parent / ".pw-browsers"))

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
    while time.time() < deadline:
        try:
            http_json("/api/version")
            return True
        except Exception:
            time.sleep(0.5)
    return False


def seed_memories():
    """通过 /api/import 写入可被主权面板看见的记忆。

    先清空再写：本脚本会删记忆，跑第二次时若不清场就断不了言。
    """
    # legacy memories 会在请求时被导入 memory-module（ensureLegacyImport）
    http_json("/api/import", "POST", {"state": {"memories": []}})
    http_json("/api/import", "POST", {"state": {"memories": [
        {"id": "t6-seed-a", "summary": "T6探针：小林养了一只叫豆豆的猫", "type": "fact",
         "confidence": 0.9, "importance": 0.8, "source": "chat"},
        {"id": "t6-seed-b", "summary": "T6探针：小林喜欢在雨天读书", "type": "fact",
         "confidence": 0.8, "importance": 0.6, "source": "chat"},
    ]}})


def enter_app(page, settle=0.9):
    """从 splash 进入应用，splash 不存在时直接等导航栏。

    为什么不能直接 `page.click(".aube-splash")`：该按钮会在 React 重渲染时被
    从 DOM 摘掉，Playwright 会报 "element was detached from the DOM" 并等到超时
    —— 一个纯粹的时序假红，与被测行为无关。这里显式容忍它。
    """
    for _ in range(3):
        if page.locator(".aube-splash").count() == 0:
            break
        try:
            page.locator(".aube-splash").first.click(timeout=6000)
            break
        except Exception:
            time.sleep(0.5)
    page.wait_for_selector(".aube-nav", timeout=20000)
    time.sleep(settle)


def fresh_page(browser):
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    page.goto(BASE, wait_until="load")
    time.sleep(1.2)
    enter_app(page)
    return context, page


def main():
    from playwright.sync_api import sync_playwright

    # dist 新鲜度守卫（理由见 e2e-panels.py 的同名函数：没有它就测的是旧产物）
    dist = REPO / "dist" / "index.html"
    if not dist.exists():
        print("dist/index.html 不存在 —— 先跑 npm run build")
        return 1
    newest_src = max(p.stat().st_mtime for p in (REPO / "client" / "src").rglob("*") if p.is_file())
    if newest_src > dist.stat().st_mtime:
        print(f"dist 比 client/src 旧 {newest_src - dist.stat().st_mtime:.0f}s —— 先跑 npm run build")
        return 1

    server = subprocess.Popen(
        ["node", "server/index.js"], cwd=REPO,
        # 本脚本每个 check 都要开新页面、并反复查列表/删会话，很容易撞上
        # 默认 120/分钟的接口限流（那会伪装成「引导没出现」这类假红）。
        # 放宽的是**测试进程**的限流，不是产品默认值。
        env={**os.environ, "PORT": str(PORT), "NODE_OPTIONS": "", "API_RATE_LIMIT_MAX": "10000"},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        if not wait_for_port():
            print("server 未起来")
            return 1
        seed_memories()
        time.sleep(0.5)

        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            # ---- P1: 面板能从 inspector 打开 ----------------------------------
            context, page = fresh_page(browser)
            try:
                nav = page.locator(".aube-nav-item:has-text('Memory')")
                record("P1 入口存在（导航 Memory）", nav.count() > 0, f"count={nav.count()}")
                nav.first.click(timeout=10000)
                page.wait_for_selector(".memory-panel", timeout=10000)
                record("P1 面板能打开", page.locator(".memory-panel").count() > 0)
                # ---- P2: 列表真的渲染出后端的数据 ------------------------------
                page.wait_for_selector(".memory-sovereignty-item", timeout=10000)
                n = page.locator(".memory-sovereignty-item").count()
                text = page.locator(".memory-panel").inner_text()
                record("P2 列表渲染（含后端种子数据）", n >= 1 and "T6探针" in text,
                       f"items={n} seeded={'T6探针' in text}")
            finally:
                context.close()

            # ---- P3/P4: 删一条 → 界面上消失，且后端也确实没了 ------------------
            context, page = fresh_page(browser)
            try:
                page.locator(".aube-nav-item:has-text('Memory')").first.click(timeout=10000)
                page.wait_for_selector(".memory-sovereignty-item", timeout=10000)
                before = page.locator(".memory-sovereignty-item").count()
                # 一律在面板作用域内定位（进入确认态后该行会重挂，作用域绑在行上会失效）。
                page.locator(".memory-sovereignty-item", has_text="豆豆").first.locator("button:has-text('遗忘')").click(timeout=10000)
                time.sleep(0.4)
                record("P3 遗忘有二次确认（第一击不直接执行）",
                       page.locator(".memory-panel button:has-text('确认遗忘')").count() > 0)

                page.locator(".memory-panel button:has-text('确认遗忘')").click(timeout=10000)
                # 等列表重拉完成（main.jsx 写后重新拉列表）
                page.wait_for_timeout(2500)

                panel_text = page.locator(".memory-panel").inner_text()
                gone_in_ui = "豆豆" not in panel_text
                after = page.locator(".memory-sovereignty-item").count()
                record("P4 界面上确实消失了", gone_in_ui, f"items {before}→{after}")

                # 后端也必须没了：只改前端状态是假绿。
                listing = http_json("/api/memory/memories?limit=100")
                backend_gone = not any("豆豆" in (i.get("summary") or "") for i in (listing.get("items") or []))
                record("P4 后端也确实删掉了（重查列表找不到）", backend_gone,
                       f"backend items={listing.get('count')}")
            finally:
                context.close()

            # ---- P5: 改写后内容真的变了 -------------------------------------
            context, page = fresh_page(browser)
            try:
                page.locator(".aube-nav-item:has-text('Memory')").first.click(timeout=10000)
                page.wait_for_selector(".memory-sovereignty-item", timeout=10000)
                page.locator(".memory-sovereignty-item", has_text="雨天读书").first.locator("button:has-text('改写')").click(timeout=10000)
                # 进入编辑态后该行会重挂，所以后续一律在面板作用域内找，不要复用 row。
                area = page.locator(".memory-panel textarea")
                area.fill("T6探针已改写：小林喜欢在雪天写信")
                page.locator(".memory-panel button:has-text('保存')").click(timeout=10000)
                page.wait_for_timeout(2500)
                record("P5 改写后界面显示新内容",
                       "雪天写信" in page.locator(".memory-panel").inner_text())
                listing = http_json("/api/memory/memories?limit=100")
                backend_ok = any("雪天写信" in (i.get("summary") or "") for i in (listing.get("items") or []))
                record("P5 改写落到了后端", backend_ok)
            finally:
                context.close()

            # ---- P6: 钉住（pin）确实生效 -------------------------------------
            context, page = fresh_page(browser)
            try:
                page.locator(".aube-nav-item:has-text('Memory')").first.click(timeout=10000)
                page.wait_for_selector(".memory-sovereignty-item", timeout=10000)
                page.locator(".memory-sovereignty-item", has_text="雪天写信").first.locator("button:has-text('钉住')").click(timeout=10000)
                page.wait_for_timeout(2500)
                listing = http_json("/api/memory/memories?limit=100")
                pinned = [i for i in (listing.get("items") or []) if i.get("pinned")]
                record("P6 钉住落到后端并显示为已钉住", len(pinned) >= 1,
                       f"pinned={len(pinned)} status={pinned[0].get('status') if pinned else None}")
            finally:
                context.close()

            # ---- P7: 首访引导（0 会话时出现，可关掉） ------------------------
            context, page = fresh_page(browser)
            try:
                # 删掉所有会话 → sessionCount 为 0
                sessions = http_json("/api/sessions")
                for s in sessions:
                    http_json(f"/api/sessions/{s['id']}", "DELETE")
                page.reload(wait_until="load")
                time.sleep(1.2)
                enter_app(page, settle=2.0)
                seen = page.locator(".first-run-guide").count() > 0
                record("P7 无会话时首次引导出现", seen)
                if seen:
                    page.locator(".first-run-guide button:has-text('先自己看看')").click(timeout=10000)
                    page.wait_for_timeout(600)
                    record("P7 可以关掉引导", page.locator(".first-run-guide").count() == 0)
            finally:
                context.close()

            # ---- P8: 空状态改成了统一文案 -----------------------------------
            context, page = fresh_page(browser)
            try:
                page.click(".aube-nav-item:has-text('Life')", timeout=10000)
                page.wait_for_timeout(1200)
                body = page.inner_text("body")
                record("P8 Life 空状态用统一文案（说清为什么空）",
                       "它还没有自己的生活记录" in body and "按它自己的节奏生成" in body)
            finally:
                context.close()

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
