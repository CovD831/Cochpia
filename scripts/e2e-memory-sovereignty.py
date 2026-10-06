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
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

REPO = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("T6_PORT", "3483"))
BASE = f"http://127.0.0.1:{PORT}"
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(REPO.parent / ".pw-browsers"))

results = []


class SkipBlock(Exception):
    """本块的**前置**没成立（例如面板没打开），后续断言无判别力。

    与真正的断言失败区分开：前置不成立时已经 record 过一条 FAIL（那条 FAIL 才是
    用户要看的信号），这里只是把控制流从当前 try 块里救出来，让**其余检查照跑**。
    直接抛 TimeoutError 会让整轮死在中途、连 SUMMARY 都打不出来 —— 实测就是这样
    丢掉过一次完整的第二次运行结果。
    """


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


def wait_for_port(proc, timeout=60):
    """等服务就绪，但**同时盯着子进程**。

    两个独立的失败模式，必须分开判：
      1. 进程已经死了（端口被占、启动抛异常）⇒ 立刻失败，把 server 的 stdout 打出来。
         光看「端口通不通」会把这种情况伪装成「等超时」，让人以为是 slow CI。
      2. 进程活着但一直不监听 ⇒ 等到超时再失败。

    为什么必须盯 proc 而不是只探测端口：`connect_ex` 成功**不代表**连上的是我们
    起的那个进程。若端口上坐着一个上次遗留的 server，探测会立刻成功，于是整轮检查
    跑在**旧进程的旧数据**上，而新起的那个早就绑定失败退出了 —— 结果是一堆看起来
    像产品缺陷的假红。这里用 poll() 把「我的子进程还活着吗」变成硬前置。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            output = ""
            try:
                output = proc.stdout.read() or ""
            except Exception:
                pass
            print(f"server 进程已退出（exit={proc.returncode}），不会再有就绪的端口。"
                  f"多半是端口 {PORT} 被占用或启动报错。server 输出：\n{output[-1500:]}")
            return False
        try:
            http_json("/api/version")
            return True
        except Exception:
            time.sleep(0.5)
    print(f"server 在 {timeout}s 内未就绪（进程仍在运行）")
    return False


SEED_MEMORIES = [
    "T6探针：小林养了一只叫豆豆的猫",
    "T6探针：小林喜欢在雨天读书",
]


def seed_state_file(tmpdir):
    """在起服务**之前**，用真实写入路径（memoryModule.hold）把种子写进 state.json。

    为什么不再走 /api/import 的 legacy 迁移通道（2026-10-07 修复）：
    `ensureLegacyImport` 里有一行早退 —— `if (legacyImportVersion === 1) return`，
    而该版本号是**一次性**的（见 server/memory-module-runtime.js:133/164）。
    于是第一次运行把 state.memories 转成 assertion 并置位之后，**再往
    state.memories 写什么都不会被转换**。旧实现的种子正是这么写的
    （先 /api/import 清空、再 /api/import 灌两条），所以它只在**从未跑过该通道**
    的环境里才有效；数据目录一旦被用过，种子就静默变成 0 条，面板渲染不出
    「豆豆」那一行，P3 的点击直接超时。

    这不是「跑两次」触发的问题 —— 本脚本每次都新建临时数据目录，所以旧实现
    在本地一直绿。真正的触发条件是**复用同一个 COCHPIA_DATA_DIR**（captain 手工
    复跑、或任何指向既有数据的入口）。既然「第二个环境就红」而「第一个环境恒绿」
    是典型的脆弱测试，这里改成不依赖迁移语义的写法：直接调生产用的 hold()，
    把结果写进 state.json，再让服务加载。优点：

      - 幂等：每次调用都是**全新的内存 state**，与磁盘上残留的旧数据无关；
      - 同形：hold 就是面板/对话写入走的那个函数，种子因此不是「特供路径」；
      - 确定：不依赖 legacyImportVersion 的历史，也不依赖提取器是否产出数据。

    注意 sourceEventId：hold 里它被当作 assertionVersionSources.sourceId 直接
    落库（memory-module.js:1033-1034），并不要求对应 rawEvent 存在（那条校验在
    createCandidate 里，是另一条路径）。我们不传它 —— 传了反而要保证传的是
    rawEvents[].id（内部 UUID）而不是对外的 eventId，那是本项目刚栽过的坑。

    关于状态文件的形状：**不能**只写 `{memoryModule}`。server/index.js 启动时
    会直接 `for (const session of state.sessions)`（index.js:124）、并读
    `state.personality.version` 等字段，缺了就当场 TypeError 起不来。
    所以这里用 `loadState()` 取**完整**的初始状态（它本身就是 store.js 里
    initialState 的形状，且该常量未导出），把种子写进它的 memoryModule 再落盘。
    """
    # `node -e` 不注入脚本路径，所以 process.argv[1] 就是第一个额外参数
    # （argv[0] 是 node 自身）—— 不是 argv[2]。实测确认过，别再按脚本文件的
    # 布局去取，否则拿到 undefined 并在 JSON.parse 处炸掉。
    script = f"""
import {{ createMemoryModule, createMemoryModuleState }} from './server/memory-module.js';
import {{ loadState, saveState }} from './server/store.js';

const contents = JSON.parse(process.argv[1]);

// 幂等：无论目标文件在不在，都从**同一份完整初始状态**出发，再种固定几条。
// 为什么不是简单地「读回来再追加」：loadState() 在文件已存在时会原样读回上一次的
// 内容，直接 hold 会叠加上去（实测同一目录连调两次得到 4 条而不是 2 条，正是
// 「跑第二次就红」的翻版）。所以这里先无条件重置 memoryModule 到空态：
// 不是只清 assertions —— versions/sources/tombstones 等派生表也要回到干净态，
// 否则第二次的 list 仍会看到上一次的残留。
//
// loadState() 在文件不存在时会写一份完整 initialState（store.js:88），借它拿到
// 「sessions/messages/personality/evidence/...」全部必需字段的正确形状；
// 缺字段的后果见 docstring 末段（server/index.js:124 会当场 TypeError）。
// 重置后立刻 saveState()，让磁盘上先有一份形状正确的完整状态。
const state = await loadState();
state.memoryModule = createMemoryModuleState();
state.memories = [];
await saveState(state);

const module = createMemoryModule(state.memoryModule, async () => {{}});
// 与 server/memory-module-runtime.js 的 contextFromRequest 在无 service identity、
// 非 production 时产出的 context 同形（tenantId 默认 local-tenant，subjectUserId
// 取 local-user）。identity 不符的记忆在 canSee() 第一行的 tenantId 比对就被滤掉，
// 表现为「种子写进去了但面板是空的」—— 那种假红比断言失败更难查。
const context = {{
  tenantId: 'local-tenant',
  subjectUserId: 'local-user',
  actorType: 'user',
  actorId: 'local-user',
  callerAgentId: null,
  sessionId: null
}};

for (const content of contents) {{
  await module.hold(context, {{
    content,
    memoryType: 'fact',
    sensitivity: 'S0',
    confidence: 0.9,
    importance: 0.8,
    source: 'chat'
  }});
}}

const created = state.memoryModule.assertions.length;
// 用 saveState() 落盘而不是自己 fs.writeFile：走的是产品自己的序列化路径，
// 与 server 启动时 loadState() 读的那份同形（含 dataDir 解析）。
await saveState(state);
console.log(JSON.stringify({{ created }}));
"""
    out = subprocess.run(
        ["node", "--input-type=module", "-e", script, json.dumps(SEED_MEMORIES)],
        # COCHPIA_DATA_DIR 必须传给这个子进程：store.js 在模块加载时就按它定位
        # dataDir，漏传会落到仓库的 server/data/，于是 loadState() 读到的是**开发
        # 环境的残留数据**，种子叠上去变成 4 条（实测过），而且还会顺手污染本机
        # 既有数据。这正是本文件要避免的那类耦合。
        env={**os.environ, "COCHPIA_DATA_DIR": str(tmpdir), "STORAGE_PROVIDER": "json"},
        cwd=REPO, capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"种子写入失败: {out.stderr.strip()[:500]}")
    created = json.loads(out.stdout.strip().splitlines()[-1])["created"]
    if created != len(SEED_MEMORIES):
        raise RuntimeError(f"种子条数不对：期望 {len(SEED_MEMORIES)}，实际 {created}")


def wait_for_condition(predicate, timeout=15000, interval=250, message=""):
    """轮询等待一个条件成立，超时返回 False（由调用方决定红还是绿）。

    为什么不用固定的 `page.wait_for_timeout(2500)`：那是「赌」写后重拉一定在 2.5s
    内完成。机器忙一点就会偶发假红，machine 快一点又白等 —— 而且失败时看不出
    差在哪。改成轮询后，等待时长由被测系统自己决定，上限只是兜底。

    轮询体里**必须**吞掉异常：请求可能在重拉途中短暂失败/元素在重渲染时被摘掉，
    那属于正常的中间态，不是失败。
    """
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        try:
            result = predicate()
            if result:
                return True
            last = result
        except Exception as error:
            last = error
        time.sleep(interval / 1000)
    if message:
        print(f"    (轮询超时 {timeout}ms：{message}；最后一次={last!r})", flush=True)
    return False


def panel_has_text(page, needle):
    return needle in page.locator(".memory-panel").inner_text()


def panel_lacks_text(page, needle):
    return needle not in page.locator(".memory-panel").inner_text()


def open_memory_panel(page, timeout=20000):
    """点导航打开记忆面板，并**确认列表真的渲染出来**。

    为什么要重试而不是一次 wait_for_selector：面板打开是一次异步 fetch
    （main.jsx openMemoryPanel），偶发失败时面板会停在 error/loading 态且**没有
    任何行**。一次性等待会直接抛 TimeoutError，整个脚本死在这一行、后面所有检查
    一条都不跑 —— 实测连跑两次时第二次就这么挂了（同一份代码，第一次全绿）。
    那是最糟的失败形态：看起来像产品坏了，其实是脚本脆弱，而且连 SUMMARY 都不出来。

    返回 (ok, detail)。ok=False 时由调用方**记一条 FAIL 继续跑**，而不是中断整轮 ——
    一轮里其余检查的信息比「第五条之后就没了」有用得多。
    """
    deadline = time.time() + timeout / 1000
    nav = page.locator(".aube-nav-item:has-text('Memory')")
    while time.time() < deadline:
        try:
            if page.locator(".memory-panel").count() == 0:
                nav.first.click(timeout=5000)
                page.wait_for_selector(".memory-panel", timeout=5000)
            if page.locator(".memory-sovereignty-item").count() > 0:
                return True, ""
            # 面板在但没有行：可能是还在 loading，也可能是真的空了。
            # 重新点一次导航会重新触发 openMemoryPanel（重拉列表）。
            nav.first.click(timeout=5000)
        except Exception:
            pass
        time.sleep(0.5)

    # 超时前把现场记下来，让失败自证是「数据没到」还是「面板报错」。
    panel_text = ""
    try:
        panel_text = page.locator(".memory-panel").inner_text().replace("\n", " / ")[:200]
    except Exception:
        panel_text = "<面板不存在>"
    return False, f"panel={page.locator('.memory-panel').count()} text={panel_text!r}"


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
    """开一个全新上下文并进入应用。

    带一次重试：偶发 `ERR_CONNECTION_REFUSED` 说明 server 在**就绪之后**掉了
    （实测发生过 —— readiness 探针刚过，进程随即退出）。那种情况下立刻抛错会让整轮
    死在第一条检查上，看不出真正原因。这里先确认 server 还活着，能恢复就继续；
    真死了就抛出带说明的异常，让上层记成一次可读的失败。
    """
    last_error = None
    for attempt in range(2):
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        try:
            page.goto(BASE, wait_until="load")
        except Exception as error:
            last_error = error
            context.close()
            if attempt == 0 and not server_is_up():
                time.sleep(2)
                continue
            raise
        time.sleep(1.2)
        enter_app(page)
        return context, page
    raise last_error


def server_is_up():
    try:
        http_json("/api/version")
        return True
    except Exception:
        return False


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

    # 端口必须真的空着。为什么值得一段守卫：本脚本若被上一次运行遗留的
    # server 占着 PORT，`wait_for_port` 会**连上那个旧进程**并立刻返回成功，
    # 于是新起的 server 绑定失败、检查却跑在旧数据上 —— 表现为
    # 「P3 找不到某条记忆」这种看起来像产品缺陷、实际是环境的假红。
    # 我本人就被它误导过一次，所以让它自己报出原因，而不是让下一个人再猜。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            print(f"端口 {PORT} 已被占用（多半是上次运行的 server 没退干净）——"
                  f"先杀掉它，或用 T6_PORT=xxxx 换一个端口")
            return 1

    tmpdir = tempfile.mkdtemp(prefix="cochpia-t6-e2e-")
    # 种子必须在**服务启动前**写进 state.json：走的是真实写入路径 hold()，
    # 而不是起服务后再靠迁移通道灌数据（理由见 seed_state_file 的 docstring）。
    # 这一步失败就直接退，不要带着空数据继续 —— 否则下面每一条检查都会红，
    # 而真正的原因（种子没建成）会被淹没在一堆看似产品缺陷的失败里。
    tmpdir_path = Path(tmpdir)
    try:
        seed_state_file(tmpdir_path)
    except Exception as error:
        print(f"种子写入失败：{error}")
        shutil.rmtree(tmpdir, ignore_errors=True)
        return 1

    server = subprocess.Popen(
        ["node", "server/index.js"], cwd=REPO,
        # 本脚本每个 check 都要开新页面、并反复查列表/删会话，很容易撞上
        # 默认 120/分钟的接口限流（那会伪装成「引导没出现」这类假红）。
        # 放宽的是**测试进程**的限流，不是产品默认值。
        #
        # COCHPIA_DATA_DIR 指向一个**一次性目录**：本脚本会删记忆、删会话，
        # 若共用仓库里 server/data/ 就会污染本机既有数据，也会让上一次运行的
        # 残留（已遗忘的记忆等）影响这一次 —— 那种耦合会让结果不可复现。
        # 顺带：每次运行都是真正的「干净环境」，这正是 P9 需要的处境。
        env={**os.environ, "PORT": str(PORT), "NODE_OPTIONS": "",
             "STORAGE_PROVIDER": "json", "COCHPIA_DATA_DIR": str(tmpdir),
             "API_RATE_LIMIT_MAX": "10000"},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        if not wait_for_port(server):
            return 1
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
                opened, detail = open_memory_panel(page)
                n = page.locator(".memory-sovereignty-item").count()
                text = page.locator(".memory-panel").inner_text() if opened else ""
                record("P2 列表渲染（含后端种子数据）", opened and n >= 1 and "T6探针" in text,
                       f"items={n} seeded={'T6探针' in text}" + (f" {detail}" if detail else ""))
            finally:
                context.close()

            # ---- P3/P4: 删一条 → 界面上消失，且后端也确实没了 ------------------
            context, page = fresh_page(browser)
            try:
                opened, open_detail = open_memory_panel(page)
                # 开不出来就记 FAIL 并跳过本块：让后面的检查照跑、SUMMARY 照出。
                # 直接抛异常会让整轮死在这里，什么信息都留不下（实测发生过）。
                record("P3 前置：记忆面板能打开且列表非空", opened, open_detail)
                if not opened:
                    raise SkipBlock("P3/P4 依赖面板列表，前置未成立")
                before = page.locator(".memory-sovereignty-item").count()
                # 一律在面板作用域内定位（进入确认态后该行会重挂，作用域绑在行上会失效）。
                page.locator(".memory-sovereignty-item", has_text="豆豆").first.locator("button:has-text('遗忘')").click(timeout=10000)
                time.sleep(0.4)
                record("P3 遗忘有二次确认（第一击不直接执行）",
                       page.locator(".memory-panel button:has-text('确认遗忘')").count() > 0)

                page.locator(".memory-panel button:has-text('确认遗忘')").click(timeout=10000)
                # 等写后重拉：轮询「面板里不再有原文」而不是赌固定 2.5s。
                # 上限 15s 只是兜底；正常情况几百毫秒就返回。
                settled = wait_for_condition(
                    lambda: panel_lacks_text(page, "豆豆"),
                    timeout=15000, message="面板仍显示被遗忘的记忆",
                )

                panel_text = page.locator(".memory-panel").inner_text()
                gone_in_ui = "豆豆" not in panel_text
                after = page.locator(".memory-sovereignty-item").count()
                record("P4 界面上确实消失了", gone_in_ui and settled,
                       f"items {before}→{after} settled={settled}")

                # 删完还要等后端**也**生效；面板消失与后端消失不是同一时刻，
                # 这里用轮询对齐，避免「UI 先绿、后端查询抢跑」造成的假红。
                backend_cleared = wait_for_condition(
                    lambda: not [i for i in (http_json("/api/memory/memories?limit=100").get("items") or [])
                                 if "豆豆" in (i.get("summary") or "")],
                    timeout=15000, message="后端仍能查到被遗忘记忆的原文",
                )

                # 只删掉目标那条：别的记忆必须还在（防「删一条清空全部」的误伤）。
                # 与 P6/P5 复用同一条幸存者，所以这里只断言它没被顺手抹掉。
                record("P4 只删了目标那条（其它记忆仍在）",
                       "雨天读书" in panel_text and after >= 1,
                       f"survivorPresent={'雨天读书' in panel_text} items={after}")

                # 后端也必须没了：只改前端状态是假绿。
                #
                # 注意判据是**内容**而不是条数：治理视图 purpose='governance' 会故意
                # 保留已遗忘的行（用户在面板上要看得到「我删过什么」），只是 summary
                # 被清空。所以 count 仍是 2 并不代表没删掉 —— 早先的 detail 只打
                # backend items=2，看着像缺陷，其实那条断言的判据一直是内容。
                # 这里把「命中几行含原文」一并打出来，让 detail 能自证。
                listing = http_json("/api/memory/memories?limit=100")
                leaked_rows = [i for i in (listing.get("items") or []) if "豆豆" in (i.get("summary") or "")]
                record("P4 后端也确实删掉了（重查列表找不到原文）", not leaked_rows and backend_cleared,
                       f"backend items={listing.get('count')} 含原文行数={len(leaked_rows)}")

                # ---- P4c: 已遗忘的行不该渲染成「没有内容的记忆」------------------
                #
                # captain 的 UI 观察：forget 之后那条变成 status=forgotten、summary 为空，
                # 面板仍把它渲染成一行**空白卡片**（只剩「已遗忘，不可再修改」）。
                # 这不是崩溃，但用户看到的是「我删了一条，列表里却多了一张空卡」——
                # 说不清发生了什么的界面，和没删干净一样可疑。
                #
                # 断言的是用户可见结果：治理列表里的每一行都必须有可读内容。
                # 允许两种正确形态：要么这行不再出现，要么它用**文案**说清自己是已遗忘
                # 的记录（而不是留白）。判据取「该行文本里有没有实质内容」，避免把
                # 样式差异当成缺陷。
                empty_rows = []
                rows = page.locator(".memory-sovereignty-item")
                for index in range(rows.count()):
                    row = rows.nth(index)
                    summary = ""
                    if row.locator(".memory-summary").count() > 0:
                        summary = row.locator(".memory-summary").first.inner_text().strip()
                    if not summary:
                        empty_rows.append(row.inner_text().strip().replace("\n", " / ")[:60])
                record("P4c 已遗忘的行不留白（每行都有内容或明确文案）", not empty_rows,
                       f"空白行数={len(empty_rows)} {empty_rows[:2]}")

                # ---- P4b: 用户按得到的那条破坏性动作必须**彻底**删除 -----------
                #
                # 为什么单独一条：上面查的是「列表接口」，而列表只是**一个**读出口。
                # T8 审计发现的 P0 正是「列表里没了、导出里还在」—— 被删内容可以经
                # /api/export 原样取回，等于删除没生效（数据主体权利失守）。
                # 只查列表的断言对这个形态**完全无感**，所以它回来了测试仍然会绿。
                #
                # 关于「哪条动作」：面板只接了 onRevoke/onForget（main.jsx:1288-1289），
                # **没有**接 DELETE /memories/:id（remove）。所以用户在 UI 上能按到的
                # 不可逆删除就是「遗忘」，本检查因此断言 forget 的彻底性。captain 的
                # P0 修复修的是 remove 路径（physicallyRemoveAssertions 会真正裁掉
                # assertionVersions），forget 不在其覆盖范围内 —— 这两条是不同的路径，
                # 断言必须跟着用户真正按得到的那条走，否则就是「测了一条产品没有的路」。
                #
                # 同时要求「幸存者仍在」：把「导出整体失败/返回空」这种假绿排除掉，
                # 否则一个恒空的导出会让前半句永远为真。
                export_payload = http_json("/api/export")
                export_text = json.dumps(export_payload, ensure_ascii=False)
                record("P4b 导出里取不回被遗忘的内容（遗忘是彻底的）",
                       "豆豆" not in export_text and "雨天读书" in export_text,
                       f"forgottenLeaked={'豆豆' in export_text} "
                       f"survivorPresent={'雨天读书' in export_text}")
            finally:
                context.close()

            # ---- P5: 改写后内容真的变了 -------------------------------------
            context, page = fresh_page(browser)
            try:
                opened, open_detail = open_memory_panel(page)
                record("P5 前置：面板能打开且列表非空", opened, open_detail)
                if not opened:
                    raise SkipBlock("P5 依赖面板列表，前置未成立")
                page.locator(".memory-sovereignty-item", has_text="雨天读书").first.locator("button:has-text('改写')").click(timeout=10000)
                # 进入编辑态后该行会重挂，所以后续一律在面板作用域内找，不要复用 row。
                area = page.locator(".memory-panel textarea")
                area.fill("T6探针已改写：小林喜欢在雪天写信")
                page.locator(".memory-panel button:has-text('保存')").click(timeout=10000)
                # 轮询等重拉，不赌固定 2.5s（同 P4）。
                ui_ok = wait_for_condition(lambda: panel_has_text(page, "雪天写信"),
                                           timeout=15000, message="面板未显示改写后的内容")
                record("P5 改写后界面显示新内容", ui_ok)
                backend_ok = wait_for_condition(
                    lambda: any("雪天写信" in (i.get("summary") or "")
                                for i in (http_json("/api/memory/memories?limit=100").get("items") or [])),
                    timeout=15000, message="后端列表未出现改写后的内容",
                )
                record("P5 改写落到了后端", backend_ok)
            finally:
                context.close()

            # ---- P6: 钉住（pin）确实生效 -------------------------------------
            context, page = fresh_page(browser)
            try:
                opened, open_detail = open_memory_panel(page)
                record("P6 前置：面板能打开且列表非空", opened, open_detail)
                if not opened:
                    raise SkipBlock("P6 依赖面板列表，前置未成立")
                page.locator(".memory-sovereignty-item", has_text="雪天写信").first.locator("button:has-text('钉住')").click(timeout=10000)
                # 轮询等 pin 落到后端（同 P4/P5）。
                pinned = []
                wait_for_condition(
                    lambda: [i for i in (http_json("/api/memory/memories?limit=100").get("items") or []) if i.get("pinned")],
                    timeout=15000, message="pin 未落到后端",
                )
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

            # ---- P9: 引导与记忆面板互斥（P1 回归）------------------------------
            #
            # 这是本文件里**唯一能抓住 P1 的那个断言**。
            #
            # P1 的形态：引导与面板都渲染 .settings-backdrop（同为 z-index:20），
            # 后挂载者在最上层 ⇒ 引导的遮罩吃掉面板全部按钮的点击。
            # 上面 P1–P6 都跑不出它，因为它们执行时**环境里还有会话**、引导压根不显示
            # —— 那正是「12/12 全绿但缺陷健在」的原因。所以这里必须现造新用户处境：
            # 删掉全部会话（含 server 自动建的 welcome），让 shouldShowGuide 为 true。
            #
            # 断言分两步且都要过：
            #   ① 遮罩只有一个 —— 两个模态同屏本身就是缺陷，用计数直接钉死；
            #   ② 「遗忘」真的点得动并进入确认态 —— 只查计数会漏掉「引导让位了
            #      但面板自己坏了」这一半。
            context, page = fresh_page(browser)
            try:
                for s in http_json("/api/sessions"):
                    http_json(f"/api/sessions/{s['id']}", "DELETE")
                # 「新用户」必须同时满足两件事：没有会话，且**没关过引导**。
                # P7 刚刚关过一次，服务端偏好和 localStorage 都记住了 —— 不把
                # 这两处一起还原，P9 的前置就恒为假，检查会退化成永远绿的噪声。
                http_json("/api/preferences", "PATCH", {"preferences": {"onboarding": {"guideDismissed": False}}})
                page.evaluate("() => window.localStorage.clear()")
                page.reload(wait_until="load")
                time.sleep(1.2)
                enter_app(page, settle=2.5)

                guide_shown = page.locator(".first-run-guide").count() > 0
                record("P9 前置：新用户处境下引导确实出现（否则本检查无判别力）", guide_shown)

                page.locator(".aube-nav-item:has-text('Memory')").first.click(timeout=10000)
                page.wait_for_selector(".memory-panel", timeout=10000)
                time.sleep(0.8)

                backdrops = page.locator(".settings-backdrop").count()
                record("P9 引导与记忆面板互斥（同时只有一层遮罩）", backdrops == 1,
                       f"backdropCount={backdrops}（修复前实测为 2）")

                # 真正点下去：被遮罩拦截时 Playwright 会在此抛超时。
                forget = page.locator(".memory-sovereignty-item button:has-text('遗忘')").first
                forget.click(timeout=6000)
                time.sleep(0.5)
                record("P9 引导存在时「遗忘」仍可点（P1 核心）",
                       page.locator(".memory-panel button:has-text('确认遗忘')").count() > 0)
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
    except SkipBlock as skip:
        # 前置不成立以致某块被跳过：那条 caveat 已经 record 成 FAIL，这里只保证
        # 后面的检查与 SUMMARY 仍然产出（见 SkipBlock 的 docstring）。
        print(f"    (跳过一块：{skip})", flush=True)
    except Exception as fatal:
        # 兜底：任何未预料的中断（server 中途掉线、浏览器崩）也要留下 SUMMARY。
        # 没有 SUMMARY 的运行等于「不知道跑到哪一步」，对排查毫无价值 ——
        # 实测丢过一次完整的第二次运行结果，就是死在这类异常上。
        # 记成一条 FAIL 而不是静默，保持「失败一定在 SUMMARY 里可见」。
        record("整轮中断（未预料异常，其余检查未能执行）", False, f"{type(fatal).__name__}: {fatal}")
        import traceback
        traceback.print_exc()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(tmpdir, ignore_errors=True)

    passed = sum(1 for _, ok, _ in results if ok)
    print("\n--- SUMMARY ---")
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'} | {name}" + (f" | {detail}" if detail else ""))
    print(f"TOTAL: {passed}/{len(results)} passed, {len(results) - passed} failed")
    print("--- END SUMMARY ---")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
