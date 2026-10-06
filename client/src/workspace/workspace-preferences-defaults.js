// 工作区偏好的缺省值与合并语义（2026-10-06 从 Provider 抽出）。
//
// 为什么单独放 .js：Provider 是 .jsx，而 `node --test` 无法加载 .jsx
// （ERR_UNKNOWN_FILE_EXTENSION）—— 放这里才能被单测直接覆盖。
//
// ⚠️ 不变量：mergeState 只遍历 defaults 里已有的键。
//   因此**服务端会返回、而 defaults 没列的 slice 会被静默丢弃**，
//   调用方拿到 undefined 却没有任何错误信号。
//   实例：首次引导的 onboarding.guideDismissed —— 服务端存了、PATCH 往返正常，
//   但客户端 merge 后恒为 undefined ⇒ 用户关掉引导、重载又弹。
//   ⇒ 新增偏好 slice 时**必须同时**加进这里与服务端 sliceKeys，
//     否则会出现「写得进读不出」或「读得到写不进」。

export const defaults = {
  theme: { themeId: 'sakura', accentColor: '#B24A6E', transitionEnabled: true, customColors: { canvas: '#160A22', panel: '#1F1130', elevated: '#2A1A40', textStrong: '#F6EDFF', textBody: '#CBB9E2', textMuted: '#9381B0', border: '#3C2852', action: '#FF6FAE', actionHover: '#FF8FC4', onAction: '#2A0B1E' } },
  background: { mode: 'color', color: '#fff6fa', imageUrl: '', gradient: 'radial-gradient(circle at 20% 10%, rgba(201,105,139,.12), transparent 38%)', blur: 0, brightness: 1, saturation: 1, opacity: 1, overlayOpacity: 0, animationEnabled: false },
  typography: { fontFamily: 'system', fontScale: 1, fontWeight: 400, letterSpacing: 0, lineHeight: 1.55 },
  motion: { enabled: false, reducedMotion: true, animationLevel: 'low', intensity: 0, durationScale: 1 },
  sound: { musicVolume: 0.2, uiVolume: 0.08, aiVoiceVolume: 0.2, muted: false, uiSoundEnabled: false, musicEnabled: false, musicReactiveEnabled: false },
  time: { clockFormat: '24h', showSeconds: false, showDate: true, timezoneMode: 'system', timezone: null, ambientModeEnabled: true },
  language: { locale: 'zh-CN', fallbackLocale: 'zh-CN' },
  accessibility: { highContrast: false, largeText: false, keyboardMode: false, focusVisible: true },
  workspace: { layoutMode: 'freeform', snapEnabled: true, autoArrangeEnabled: false, dockVisible: true },
  appearance: { cornerRadius: 24, panelOpacity: 1.0 },
  // 首次引导的「已关闭」标记（2026-10-06 修）。
  // mergeState 是 `Object.keys(defaults).reduce(...)` —— **只遍历 defaults 里已有的键**，
  // 所以服务端返回的 onboarding 若不在 defaults 里会被**静默丢弃**，
  // `workspacePreferences.onboarding` 恒为 undefined ⇒ 引导关掉后重载又弹。
  // 这与服务端 `workspace-preferences.js` 的 `sliceKeys` 是**同一缺陷的两层**
  // （服务端一度也没列 onboarding，已一并修复）—— 只修一层，引导仍然关不掉。
  onboarding: { guideDismissed: false }
};

export const mergeState = value => Object.keys(defaults).reduce((result, key) => {
  result[key] = { ...defaults[key], ...(value?.[key] || {}) };
  return result;
}, {});
