// 记忆主权面板（Memory Sovereignty Panel）。
//
// 这块面板要回答一个用户真正会问的问题：「你到底记了我什么，我能改吗、能删吗？」
// 在它出现之前，记忆只在「最近记忆」里被单向展示——用户看得见，但改不了、删不掉。
// 「可见/可改/可删」里只有一个「可见」是真的，护城河因此是假的。
//
// ── 设计约束（都是刻意的）────────────────────────────────────────────
//
// 1. **纯受控组件，自己不发任何 HTTP 请求。**
//    全部网络动作通过 props 回调（onCorrect/onPin/onRevoke/onForget/onLoadMore）
//    交给 integrator。这样网络层只有一处（main.jsx），组件的可测性也最好。
//    ⇒ 本文件**没有** `import { api }`，没有 fetch。
//
// 2. **破坏性动作必须二次确认。**
//    「遗忘」和「撤销」是不可逆的（撤销=不再使用但保留审计，遗忘=内容消失）。
//    一次点击就删掉用户的记忆，是这个面板最不能被接受的行为。实现见
//    `pendingConfirm` 状态：第一次点击只把该条目切换到「确认/取消」，绝不调用回调。
//
// 3. **时间格式化必须容错。**
//    任何时间都走 memory-panel-utils 的 formatMemoryTime（内部 try/catch +
//    类型白名单）。在 JSX 里直接 `new Date(x).toLocaleString()` 是**禁止**的：
//    非法日期会抛 RangeError，冒泡到 AppErrorBoundary 会把整个应用换成错误页。
//
// 4. **样式只用 CSS 变量，复用既有视觉语言。**
//    复用 .inspector/.state-card/.memory-item/.section-heading/.text-button/
//    .panel-error/.empty-detail/.eyebrow 等既有类；新增的少量类在组件内的
//    Object.assign(…, <style>) 里定义——样式表由 integrator 独占，我不去动。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  groupMemoriesByScope,
  memoryCountLabel,
  memoryKey,
  memoryStatusLabel,
  memoryTypeLabel,
  memoryScopeLabel,
  confidencePercent,
  normalizeStatus,
  canForget,
  canRevoke,
  canCorrect,
  canPin,
  isPinned,
  validateSummaryDraft,
  formatMemoryTime,
  panelPhase
} from './memory-panel-utils.js';

// 需要二次确认的动作（终态、不可逆）。
const CONFIRM_ACTIONS = {
  forget: { verb: '遗忘', note: '遗忘后内容将不再返回，且不可恢复。' },
  revoke: { verb: '撤销', note: '撤销后这条记忆不再被使用，但审计记录会保留。' }
};

// 受控输入行：key 由父级用「记忆 id」控制，React 会在换条目时重挂，
// 因此不需要把 props 同步进 state 的 useEffect（那是最容易出 bug 的一处）。
function MemoryRow({ item, index, busy, confirming, draft, editing, onStartEdit, onDraftChange, onCancelEdit, onSubmitEdit, onPin, onAskConfirm, onConfirm, onCancelConfirm }) {
  const status = normalizeStatus(item.status);
  const percent = confidencePercent(item);
  const pinned = isPinned(item);

  return (
    <article className={`memory-item memory-sovereignty-item is-${status}`} data-status={status}>
      <div className="memory-item-meta">
        <span className="memory-type">{memoryTypeLabel(item)}</span>
        <span className={`memory-status memory-status-${status}`}>{memoryStatusLabel(item.status)}</span>
        <span className="memory-scope" title="这条记忆的作用范围">{memoryScopeLabel(item.scopeType)}</span>
      </div>

      {editing ? (
        <form
          className="memory-edit"
          onSubmit={event => { event.preventDefault(); onSubmitEdit(item.id, draft); }}
        >
          <label className="memory-edit-label" htmlFor={`memory-draft-${memoryKey(item, index)}`}>
            改写这条记忆的内容
          </label>
          <textarea
            id={`memory-draft-${memoryKey(item, index)}`}
            className="memory-edit-input"
            value={draft}
            rows={3}
            maxLength={2000}
            onChange={event => onDraftChange(event.target.value)}
          />
          <div className="memory-actions">
            <button type="submit" className="select-model" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
            <button type="button" className="text-button muted-button" disabled={busy} onClick={() => onCancelEdit(item.id)}>取消</button>
          </div>
        </form>
      ) : (
        <p className="memory-summary">{item.summary}</p>
      )}

      <small className="memory-footnote">
        {percent === null ? '确信度未知' : `${percent}% 确信`}
        {' · '}
        {item.source ? String(item.source) : '来源未知'}
        {' · '}
        {/* 唯一的时间出口：非法值降级为「时间未知」，绝不抛 */}
        <time dateTime={typeof item.createdAt === 'string' ? item.createdAt : undefined}>{formatMemoryTime(item.createdAt)}</time>
      </small>

      {confirming ? (
        <div className="memory-confirm" role="alert">
          <span className="memory-confirm-text">
            确定要{CONFIRM_ACTIONS[confirming].verb}这条记忆吗？{CONFIRM_ACTIONS[confirming].note}
          </span>
          <div className="memory-actions">
            <button type="button" className="text-button danger-button" disabled={busy} onClick={() => onConfirm(item.id, confirming)}>
              {busy ? '处理中…' : `确认${CONFIRM_ACTIONS[confirming].verb}`}
            </button>
            <button type="button" className="text-button muted-button" disabled={busy} onClick={() => onCancelConfirm(item.id)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="memory-actions">
          {canCorrect(item) && <button type="button" className="text-button" disabled={busy} onClick={() => onStartEdit(item.id, item.summary || '')}>改写</button>}
          {canPin(item) && (
            <button type="button" className="text-button" disabled={busy} onClick={() => onPin(item.id, !pinned)}>
              {pinned ? '取消钉住' : '钉住'}
            </button>
          )}
          {/* 第一击只进入确认态，绝不直接调用 onForget/onRevoke */}
          {canRevoke(item) && <button type="button" className="text-button" disabled={busy} onClick={() => onAskConfirm(item.id, 'revoke')}>撤销</button>}
          {canForget(item) && <button type="button" className="text-button danger-button" disabled={busy} onClick={() => onAskConfirm(item.id, 'forget')}>遗忘</button>}
          {/* 终态条目没有可用动作：说清楚为什么，而不是留一片空白按钮区 */}
          {!canCorrect(item) && !canPin(item) && !canRevoke(item) && !canForget(item) && (
            <span className="memory-inert-note">已{memoryStatusLabel(item.status)}，不可再修改</span>
          )}
        </div>
      )}
    </article>
  );
}

export default function MemorySovereigntyPanel({
  memories,
  truncated = false,
  loading = false,
  error = null,
  onCorrect,
  onPin,
  onRevoke,
  onForget,
  onLoadMore,
  hasMore = false
}) {
  // 二次确认：{ [id]: 'forget' | 'revoke' }。为空时，任何破坏性回调都不会被调用。
  const [pendingConfirm, setPendingConfirm] = useState({});
  // 改写草稿：{ [id]: string }；editingId 同时作为 textarea 的 key。
  const [drafts, setDrafts] = useState({});
  const [editingId, setEditingId] = useState(null);
  // 进行中的动作：{ [id]: 'forget' | 'revoke' | 'pin' | 'correct' }，用于禁用按钮防重复提交。
  const [busyId, setBusyId] = useState(null);

  const liveIdsRef = useRef(null);
  const liveIds = useMemo(() => new Set((Array.isArray(memories) ? memories : []).map((item, index) => memoryKey(item, index))), [memories]);

  // 条目从列表消失后（被删掉/换了筛选条件），清掉它的确认态与草稿。
  // 否则「待确认遗忘」会一直挂在 state 里，用户下次看到同 id 的条目会
  // 莫名其妙地处于确认态——一个跨渲染周期的幽灵状态。
  useEffect(() => {
    if (liveIdsRef.current && liveIdsRef.current.size === 0 && liveIds.size === 0) return;
    liveIdsRef.current = liveIds;
    setPendingConfirm(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => liveIds.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    setDrafts(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => liveIds.has(id)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [liveIds]);

  const groups = useMemo(() => groupMemoriesByScope(memories), [memories]);
  const phase = panelPhase({ loading, error, memories, hasMore });
  const countLabel = memoryCountLabel(memories, truncated);

  // 统一的动作包装：先置忙，await 回调（可能是返回 Promise 的网络请求），
  // 最后清忙。回调缺失时静默 no-op —— 面板在只读场景下也必须能渲染。
  const runAction = async (id, kind, fn) => {
    if (typeof fn !== 'function' || busyId) return;
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  };

  const askConfirm = (id, kind) => setPendingConfirm(current => ({ ...current, [id]: kind }));
  const cancelConfirm = id => setPendingConfirm(current => {
    const next = { ...current };
    delete next[id];
    return next;
  });

  const confirmAction = (id, kind) => {
    const handler = kind === 'forget' ? onForget : onRevoke;
    runAction(id, kind, async () => {
      await handler?.(id);
      // 只有在动作真的被交给上层之后，才收起确认态。
      cancelConfirm(id);
    });
  };

  const startEdit = (id, summary) => {
    setEditingId(id);
    setDrafts(current => ({ ...current, [id]: summary }));
  };

  const cancelEdit = id => {
    setEditingId(current => (current === id ? null : current));
    setDrafts(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const submitEdit = (id, draft) => {
    const checked = validateSummaryDraft(draft);
    if (!checked.ok) return; // 空内容不允许提交（组件层已挡，纯函数层也有断言）
    runAction(id, 'correct', async () => {
      await onCorrect?.(id, checked.value);
      cancelEdit(id);
    });
  };

  return (
    <section className="inspector-section memory-sovereignty" aria-labelledby="memory-sovereignty-title">
      <header className="section-heading">
        <span id="memory-sovereignty-title">我的记忆</span>
        <span className="count-label">{countLabel}</span>
      </header>

      <p className="memory-sovereignty-note">
        这里是你和它之间的全部记忆。你可以改写、钉住、撤销或遗忘其中任何一条。
      </p>

      {error && <div className="panel-error" role="alert">{typeof error === 'string' ? error : '记忆加载失败，请稍后重试。'}</div>}

      {phase === 'loading' && <p className="empty-detail" role="status">正在加载记忆…</p>}

      {phase === 'empty' && !error && (
        <p className="empty-detail">还没有任何记忆。聊几句之后，它记住的事会出现在这里，由你处置。</p>
      )}

      {(phase === 'list' || phase === 'loading') && groups.map(group => (
        <div className="memory-group" key={group.scope}>
          <div className="section-heading memory-group-heading">
            <span>{group.label}</span>
            <span className="count-label">{group.items.length} 条</span>
          </div>
          {group.items.map((item, index) => {
            const id = memoryKey(item, index);
            return (
              <MemoryRow
                key={id}
                item={item}
                index={index}
                busy={busyId === item.id}
                confirming={pendingConfirm[id] || null}
                draft={drafts[id] ?? ''}
                editing={editingId === id}
                onStartEdit={startEdit}
                onDraftChange={value => setDrafts(current => ({ ...current, [id]: value }))}
                onCancelEdit={cancelEdit}
                onSubmitEdit={submitEdit}
                onPin={(pinId, next) => runAction(pinId, 'pin', () => onPin?.(pinId, next))}
                onAskConfirm={askConfirm}
                onConfirm={confirmAction}
                onCancelConfirm={cancelConfirm}
              />
            );
          })}
        </div>
      ))}

      {hasMore && (
        <button type="button" className="text-button memory-load-more" disabled={loading} onClick={() => onLoadMore?.()}>
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </section>
  );
}

// 本组件新增的少量类。写在组件文件里、只在装载时注入一次，是因为样式表
// （client/src/styles.css）由集成 track 独占；全部取值只用既有 CSS 变量，
// 没有任何硬编码颜色，因此自动跟随全部主题（dark/paper/blush/mist/night/…）。
if (typeof document !== 'undefined' && !document.getElementById('memory-sovereignty-styles')) {
  const style = document.createElement('style');
  style.id = 'memory-sovereignty-styles';
  style.textContent = `
.memory-sovereignty-note { color:var(--text-muted); font-size:10px; line-height:1.6; margin:0 0 14px; }
.memory-group + .memory-group { margin-top:14px; }
.memory-group-heading { margin-bottom:4px; }
.memory-group-heading span:first-child { color:var(--text-body); font-size:10px; letter-spacing:.06em; }
.memory-sovereignty-item { display:block; }
.memory-sovereignty-item.is-forgotten, .memory-sovereignty-item.is-revoked { opacity:.62; }
.memory-item-meta { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.memory-item-meta .memory-type { margin-bottom:0; }
.memory-status { font-size:9px; border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:2px 5px; color:var(--text-muted); }
.memory-status-active { color:var(--action-primary); border-color:color-mix(in srgb, var(--action-primary) 27%, transparent); }
.memory-status-pinned { color:var(--state-warning); border-color:color-mix(in srgb, var(--state-warning) 35%, transparent); }
.memory-status-revoked { color:var(--text-muted); }
.memory-status-forgotten { color:var(--state-danger); border-color:color-mix(in srgb, var(--state-danger) 27%, transparent); }
.memory-scope { font-size:9px; color:var(--text-muted); }
.memory-summary { margin-top:7px; }
.memory-footnote { display:block; }
.memory-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:9px; }
.memory-actions .text-button { cursor:pointer; }
.memory-actions .text-button:disabled { opacity:.5; cursor:default; }
.danger-button { color:var(--state-danger); }
.memory-edit { margin-top:9px; }
.memory-edit-label { display:block; color:var(--text-muted); font-size:9px; margin-bottom:5px; }
.memory-edit-input { width:100%; box-sizing:border-box; background:var(--surface-elevated); color:var(--text-body); border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:8px; font-size:11px; line-height:1.6; font-family:inherit; resize:vertical; }
.memory-edit-input:focus { outline:none; border-color:var(--focus-ring); }
.memory-confirm { margin-top:9px; border:1px solid color-mix(in srgb, var(--state-danger) 40%, transparent); border-radius:var(--radius-sm); padding:9px; background:color-mix(in srgb, var(--state-danger) 8%, transparent); }
.memory-confirm-text { display:block; color:var(--text-body); font-size:10px; line-height:1.6; }
.memory-confirm .memory-actions { margin-top:8px; }
.memory-inert-note { color:var(--text-muted); font-size:10px; }
.memory-load-more { display:block; margin:16px auto 0; cursor:pointer; }
.memory-load-more:disabled { opacity:.5; cursor:default; }
`;
  document.head.appendChild(style);
}
