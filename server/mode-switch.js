// R-020 stage 3: mode-switch detection, shared by the server and the client.
//
// Why this lives in its own module: the server needs it to answer a switch
// request, and the client needs it to decide whether a message goes to
// /api/chat/turns (companion) or /api/chat/work (work mode). Two copies of the
// same regex would drift, and the failure mode is silent -- the user types
// "切换到工作模式", the message lands on the companion path, and nothing
// happens. Keeping one implementation removes that class of bug entirely.
//
// It must stay dependency-free: the client imports it, so it cannot pull in
// any Node built-in.

const WORK_PATTERN = /(切换到|进入|开启|切到|回到|切换).{0,4}工作模式/;
const COMPANION_PATTERN = /(切换到|进入|开启|切到|回到|切换).{0,4}陪伴模式/;

export const MODE_SWITCH_SAMPLES = Object.freeze({
  work: ['切换到工作模式', '进入工作模式', '切到工作模式', '回到工作模式', '切换一下工作模式', '工作模式'],
  companion: ['切换到陪伴模式', '进入陪伴模式', '切到陪伴模式', '回到陪伴模式', '切换一下陪伴模式', '陪伴模式'],
  neither: ['我今天工作模式调整了', '这个模型的模式是什么', '陪我聊聊', '', '工作', '模式']
});

// Returns 'work' | 'companion' | null. A bare "工作模式" / "陪伴模式" counts as
// a switch command, matching the original server behaviour.
export function detectModeSwitch(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (WORK_PATTERN.test(trimmed) || trimmed === '工作模式') return 'work';
  if (COMPANION_PATTERN.test(trimmed) || trimmed === '陪伴模式') return 'companion';
  return null;
}

// The client uses this to pick an endpoint; the server uses detectModeSwitch
// to act on it. A message that is a switch command, or a session already in
// work mode, belongs on the work route.
export function isWorkRouteMessage({ mode, text } = {}) {
  if (mode === 'work') return true;
  return detectModeSwitch(text) !== null;
}
