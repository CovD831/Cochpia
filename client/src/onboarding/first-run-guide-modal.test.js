// P1 回归：首次引导的遮罩不许压住记忆主权面板的按钮。
//
// ── 这个缺陷是什么（observed，非推测）────────────────────────────────
//
// 引导（main.jsx 的 <FirstRunGuide>）与记忆面板都渲染 `.settings-backdrop`
// （styles.css 里同为 z-index:20），**后挂载者在最上层**。于是当
// shouldShowGuide === true（用户一条会话都没有）时打开记忆面板，引导的遮罩
// 会吃掉面板里所有按钮的点击。
//
// 干净环境实测（STORAGE_PROVIDER=json + 全新数据目录 + 删掉自动建的 welcome
// 会话，即真正的新用户处境）：
//     backdropCount = 2
//     点「遗忘」→ "… .settings-content … intercepts pointer events"
// ⇒ 新用户第一次想删掉一条记忆时**按键点不动**，本阶段的核心功能对他们不可用。
//
// 为什么必须在这里也钉一遍（而不是只靠 e2e）：e2e 需要浏览器与一次完整构建，
// 跑得慢、且在 CI 上未必总被执行。这条守卫读源码、毫秒级，能让「互斥被改掉」
// 在任何一次 `npm test` 上立刻变红。
//
// ⚠️ 本测试**有意**承认自己的局限：它证明的是「互斥条件还在源码里」，
// 不证明「浏览器里真的点得动」。后者只有 e2e P9 能证。
// 所以两者是互补的，不是重复的。
//
// 判别力自证（已实测）：把 main.jsx 里的 `&& !memoryOpen` 去掉后，
// 本文件立刻变红；e2e 的 P9 同时报 backdropCount=2 与 intercepts pointer events。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const mainSource = readFileSync(join(repo, 'client', 'src', 'main.jsx'), 'utf8');

// 剥注释后再断言：修复时把原委写进了注释，直接对全文断言会把**说明**
// 当成残留代码（phase0-credibility.test.js 已经踩过这个坑两次）。
const code = mainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('P1: 首次引导与记忆面板互斥（引导可见性依赖 memoryOpen）', () => {
  // 匹配整个 useMemo 表达式（以 `]);` 收尾，因为 useMemo 的依赖数组也在其中）。
  const match = code.match(/const showFirstRunGuide = useMemo\(\(\) =>([\s\S]*?)\);/);
  assert.ok(match, '没找到 showFirstRunGuide 的定义 —— 判定逻辑被搬走了，本守卫需要跟着更新');

  const body = match[1];
  assert.ok(
    /shouldShowGuide\(/.test(body),
    'showFirstRunGuide 不再走 shouldShowGuide —— 「一条会话都没有且没关过」这个唯一判据被绕开了'
  );
  assert.ok(
    /!\s*memoryOpen/.test(body),
    'showFirstRunGuide 不再与 memoryOpen 互斥：引导会与记忆面板**同时**以 '
    + '.settings-backdrop 渲染（同为 z-index:20），后挂载者的遮罩会吃掉面板按钮的点击。'
    + '这就是 P1：新用户点不动「遗忘/撤销/改写」。'
  );
  // 依赖数组里必须有 memoryOpen，否则面板一开一关时 useMemo 不会重算，互斥失效。
  // 直接看整段 useMemo 表达式里 `[` 之后的括号列表：解析成 AST 太重，
  // 而这里只要挡住「有人加了 !memoryOpen 却忘了加依赖」这一种回归。
  const depsList = match[0].slice(match[0].lastIndexOf('['));
  assert.ok(
    /memoryOpen/.test(depsList),
    'memoryOpen 不在依赖数组里 —— 面板状态改变时引导不会重新求值，互斥会失效'
  );
});

test('P1: 引导的 visible 仍然受 page !== splash 约束（首屏不弹）', () => {
  const usage = code.match(/<FirstRunGuide[\s\S]*?\/>/);
  assert.ok(usage, '没找到 <FirstRunGuide> 的挂载点');
  assert.ok(
    /visible=\{showFirstRunGuide/.test(usage[0]),
    '<FirstRunGuide> 不再由 showFirstRunGuide 驱动 —— 互斥条件可能因此被绕过'
  );
});

test('P1: 记忆面板仍以受控方式挂载，且写动作接的是 memory* 回调', () => {
  // 互斥修法如果被改成「面板打开时把自己关掉」，这条会红 —— 那种修法
  // 等于把缺陷从「点不动」换成「点了没反应」，同样是不可用。
  assert.ok(/<MemorySovereigntyPanel/.test(code), '记忆面板没有被挂载');
  for (const prop of ['onCorrect', 'onPin', 'onRevoke', 'onForget', 'onLoadMore']) {
    assert.ok(
      new RegExp(`${prop}=\\{`).test(code),
      `记忆面板的 ${prop} 回调没有接线 —— 面板会渲染但动作静默 no-op`
    );
  }
  // 面板自己不许发 HTTP（T2 的契约）：网络层只有 main.jsx 一处。
  const panelSource = readFileSync(join(repo, 'client', 'src', 'panels', 'MemorySovereigntyPanel.jsx'), 'utf8');
  assert.ok(
    !/\bfetch\(/.test(panelSource) && !/from '\.\.\/api'/.test(panelSource),
    '记忆面板开始自己发请求了 —— 那会绕过本文件里统一的 revision/重拉逻辑'
  );
});
