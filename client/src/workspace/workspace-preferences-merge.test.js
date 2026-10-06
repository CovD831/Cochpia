// 回归：偏好合并不得静默丢 slice（2026-10-06 修）。
//
// 缺陷形态：`mergeState` 是 `Object.keys(defaults).reduce(...)` —— **只遍历 defaults
// 里已有的键**。所以服务端返回的 slice 若不在 defaults 里，会被**静默丢弃**，
// 调用方拿到 undefined 却没有任何错误信号。
//
// 具体案例：首次引导的 `onboarding.guideDismissed`。服务端已存、PATCH 往返正常，
// 但客户端 merge 后 `workspacePreferences.onboarding` 恒为 undefined
// ⇒ 用户关掉引导、重载后引导又弹回来。
//
// 这与服务端 `workspace-preferences.js` 的 `sliceKeys` 是**同一缺陷的两层**：
// 服务端漏列 ⇒ 写不进；客户端漏列 ⇒ 读不到。**任一层没修，引导都关不掉。**
// 两层现在都有回归断言（本文件 + server/workspace-preferences.test.js）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaults, mergeState } from './workspace-preferences-defaults.js';

test('回归：mergeState 不得丢弃服务端返回的 onboarding slice', () => {
  const merged = mergeState({ theme: { themeId: 'ink' }, onboarding: { guideDismissed: true } });
  assert.ok('onboarding' in merged, 'onboarding 被 mergeState 丢弃 ⇒ 引导关不掉');
  assert.equal(merged.onboarding.guideDismissed, true);
  // 其它 slice 仍正常合并（没有因新 slice 而破坏既有行为）
  assert.equal(merged.theme.themeId, 'ink');
});

test('回归：onboarding 缺省值存在，且缺省为「未关闭」', () => {
  assert.ok(defaults.onboarding, 'defaults 缺少 onboarding ⇒ 服务端值会被静默丢弃');
  assert.equal(defaults.onboarding.guideDismissed, false, '缺省必须是未关闭，否则新用户看不到引导');
});

test('合并语义：每个 defaults slice 都必须在结果中出现（防止未来再漏）', () => {
  const merged = mergeState({});
  for (const slice of Object.keys(defaults)) {
    assert.ok(slice in merged, `slice "${slice}" 在合并结果里缺失`);
  }
});

test('合并语义：服务端值覆盖缺省，未提供的键保留缺省', () => {
  const merged = mergeState({ onboarding: { guideDismissed: true } });
  assert.equal(merged.onboarding.guideDismissed, true, '服务端值应生效');
  const empty = mergeState({});
  assert.equal(empty.onboarding.guideDismissed, false, '未提供时保留缺省');
});
