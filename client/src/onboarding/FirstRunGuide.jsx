// 首次引导：新用户打开应用、还没有任何会话时显示的一次性说明。
//
// 为什么值得单独做一个组件：产品真正的差异点是「共同记忆是透明、可审计、可反悔的」，
// 而这一点在界面上**没有任何入口** —— 新用户看到的是一个空白的对话页，
// 无从知道这里和别的聊天工具有什么不同。引导的唯一职责就是把这件事说清楚，
// 并且只说真话（文案全部在 ./empty-states.js，附了每条承诺对应的后端路由）。
//
// 契约（集成 track 按此接线）：
//   <FirstRunGuide visible onDismiss onStart />
// visible 由调用方决定何时显示（见 shouldShowGuide）；
// 本组件不自己读写偏好、不发请求、不持有跨渲染状态 —— 它只渲染 + 回调。

import React from 'react';
import FeatherIcon from '../icons/FeatherIcon';

import {
  GUIDE_TITLE,
  GUIDE_BODY,
  GUIDE_DISMISS_LABEL,
  GUIDE_START_LABEL,
  GUIDE_START_HINT,
  guidePoints
} from './empty-states.js';

export function FirstRunGuide({ visible, onDismiss, onStart }) {
  // 不可见时返回 null（而不是靠 CSS 隐藏）：隐藏的对话框仍会占在 Tab 顺序里，
  // 键盘用户会 Tab 进一个看不见的按钮。
  if (!visible) return null;

  // 回调一律做类型保护：集成方可能只传其中一半（例如只想给 onDismiss）。
  // 少一个回调应当是「那个按钮不出现」，而不是点击时抛 TypeError —— 那会被
  // AppErrorBoundary 接住，把整个应用换成错误页。
  const dismiss = typeof onDismiss === 'function' ? onDismiss : null;
  const start = typeof onStart === 'function' ? onStart : null;
  const points = guidePoints();

  return (
    // 背景遮罩：点击遮罩等于「关掉」，与 ProfilePanel / GrowthPanel 的既有行为一致。
    <div
      className="settings-backdrop"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget && dismiss) dismiss(); }}
    >
      <section
        className="settings-panel detail-panel first-run-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-guide-title"
      >
        <header className="settings-header">
          <div>
            <p className="eyebrow">YOUR MEMORY, YOUR CALL</p>
            <h2 id="first-run-guide-title">{GUIDE_TITLE}</h2>
            <p>{GUIDE_BODY}</p>
          </div>
          {dismiss && (
            <button
              type="button"
              className="icon-button"
              aria-label="关闭首次引导"
              title="关闭首次引导"
              onClick={() => dismiss()}
            >
              <FeatherIcon name="x" size={16} />
            </button>
          )}
        </header>

        <div className="settings-content">
          {/* 四条能力，逐条说明「你能做什么」。用 <ul> 而不是装饰性卡片：
              这是承诺清单，读起来就该像清单。
              样式只用内联的 CSS 变量（不硬编码颜色）：本组件不得改 styles.css
              （那是集成 track 独占的写域），所以它必须在**没有新增样式**的前提下
              也是可读的。列宽、间距都取自既有变量。 */}
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--space-4)'
            }}
          >
            {points.map(point => (
              <li
                key={point.id}
                style={{
                  borderTop: '1px solid var(--border-default)',
                  paddingTop: 'var(--space-3)'
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    color: 'var(--action-primary)',
                    fontSize: '10px',
                    letterSpacing: '.14em',
                    textTransform: 'uppercase'
                  }}
                >
                  {point.label}
                </span>
                <p style={{ color: 'var(--text-body)', fontSize: '12px', lineHeight: 1.7, marginTop: '6px' }}>
                  {point.body}
                </p>
              </li>
            ))}
          </ul>

          {/* 这里是**真的**能点的动作；旁边的 dismiss 是「先不看」。
              两个都给出：强制看完一段说明才放人进去，是另一种不友好。 */}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 'var(--space-5)' }}>
            {start && (
              <button type="button" className="select-model" onClick={() => start()}>
                {GUIDE_START_LABEL}
              </button>
            )}
            {dismiss && (
              <button type="button" className="text-button muted-button" onClick={() => dismiss()}>
                {GUIDE_DISMISS_LABEL}
              </button>
            )}
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: 'var(--space-3)' }}>{GUIDE_START_HINT}</p>
        </div>
      </section>
    </div>
  );
}

export default FirstRunGuide;
