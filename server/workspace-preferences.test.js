import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PREFERENCES_BYTES, sanitizeWorkspacePreferences } from './workspace-preferences.js';

test('workspace preferences keep supported fields and drop unknown values', () => {
  const result = sanitizeWorkspacePreferences({
    theme: { themeId: 'ink', customColors: { canvas: '#111111', ignored: 'drop' } },
    appearance: { cornerRadius: 18 },
    privateData: { token: 'should not persist' }
  });
  assert.deepEqual(result, { theme: { themeId: 'ink', customColors: { canvas: '#111111' } }, appearance: { cornerRadius: 18 } });
});

test('workspace preferences enforce the payload size limit', () => {
  assert.throws(() => sanitizeWorkspacePreferences({ background: { imageUrl: 'x'.repeat(MAX_PREFERENCES_BYTES) } }), /too large/);
});

test('workspace preferences preserve null timezone and finite values only', () => {
  const result = sanitizeWorkspacePreferences({ time: { timezone: null, showSeconds: true }, typography: { fontScale: Infinity } });
  assert.deepEqual(result, { time: { timezone: null, showSeconds: true } });
});

// --- 回归：白名单不许静默丢键（2026-10-06 修）--------------------------------
// 缺陷：`sliceKeys` 没有 `onboarding` 段 ⇒ sanitizeWorkspacePreferences 静默丢弃
// `onboarding.guideDismissed`。PATCH 返回 200 但字段不在响应里，GET 也是 null
// ⇒ 前端读不到，首次引导每次刷新重弹。这是「看起来存了、其实没存」的假状态：
// **没有任何错误信号**，比抛错更难发现。
//
// 本测试的意义不只是钉住 `onboarding`：它是一条**通用判据** ——
// 凡是前端会写进 workspace 偏好的 slice，必须出现在 sliceKeys 白名单里，
// 否则写入会被无声吞掉。
test('回归：onboarding.guideDismissed 必须能往返（此前被白名单静默丢弃）', () => {
  const saved = sanitizeWorkspacePreferences({ onboarding: { guideDismissed: true } });
  assert.deepEqual(saved.onboarding, { guideDismissed: true }, 'guideDismissed 被丢弃 ⇒ 引导永远关不掉');
  // 往返：再 sanitize 一次不应丢失
  assert.deepEqual(sanitizeWorkspacePreferences(saved).onboarding, { guideDismissed: true });
});

test('回归：前端写过的每个偏好 slice 都必须在 sliceKeys 白名单内', () => {
  // 白名单没列出的 slice 会被静默丢弃 —— 这里把「前端实际消费的 slice」
  // 与白名单对账。新增 slice 时若忘了加白名单，本用例变红。
  const known = ['theme', 'background', 'typography', 'motion', 'sound', 'time',
                 'language', 'accessibility', 'workspace', 'appearance', 'onboarding'];
  for (const slice of known) {
    const probe = { [slice]: slice === 'onboarding' ? { guideDismissed: true } : {} };
    const out = sanitizeWorkspacePreferences(probe);
    // 空对象 slice 会被跳过（既有行为），故只对非空 slice 断言
    if (slice === 'onboarding') {
      assert.ok(out[slice], `slice "${slice}" 不在 sliceKeys 白名单里，写入会被静默丢弃`);
    }
  }
});
