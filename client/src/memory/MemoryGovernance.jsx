import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

const STATUS_LABELS = {
  active: '已激活',
  candidate: '候选',
  pending_confirmation: '待确认',
  revoked: '已撤回',
  forgotten: '已忘记',
  deleted: '已删除',
  rejected: '已拒绝',
  superseded: '已被替代',
  expired: '已过期'
};

const TYPE_LABELS = {
  preference: '偏好',
  relationship: '关系',
  fact: '事实',
  goal: '目标',
  event: '事件',
  current_state: '当前状态'
};

const asArray = value => Array.isArray(value) ? value : [];

function statusLabel(status) {
  return STATUS_LABELS[status] || status || '未知';
}

function typeLabel(type) {
  return TYPE_LABELS[type] || type || '记忆';
}

function formatMemoryDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function createMutationBody(action, id, revision, extra = {}) {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return JSON.stringify({
    ...extra,
    resource_revision: revision,
    idempotency_key: `memory-ui:${action}:${id}:${revision}:${randomId}`
  });
}

function MemoryStatusBadge({ status }) {
  return <span className={`memory-governance-status status-${status || 'unknown'}`}>{statusLabel(status)}</span>;
}

function MemoryCard({
  memory,
  confirmation,
  busy,
  editing,
  draft,
  onStartEdit,
  onCancelEdit,
  onDraftChange,
  onSaveEdit,
  onConfirm,
  onReject,
  onPromote,
  onTogglePin,
  onForget,
  onRevoke,
  onDelete
}) {
  const status = memory.status || 'active';
  const canEdit = status === 'active' || status === 'candidate';
  const content = memory.summary || confirmation?.proposedContent || '';
  const hidden = ['revoked', 'forgotten', 'deleted', 'rejected', 'expired', 'superseded'].includes(status);

  return <article className={`memory-governance-card status-${status}`}>
    <div className="memory-governance-card-head">
      <div className="memory-governance-card-title">
        <MemoryStatusBadge status={status} />
        <span className="memory-governance-type">{typeLabel(memory.type)}</span>
        {memory.pinned && <span className="memory-governance-pin" title="已 Pin">✦ Pin</span>}
      </div>
      <time dateTime={memory.updatedAt}>{formatMemoryDate(memory.updatedAt)}</time>
    </div>

    {editing ? <div className="memory-governance-edit">
      <textarea value={draft} onChange={event => onDraftChange(event.target.value)} rows="4" aria-label="修正记忆内容" autoFocus />
      <div className="memory-governance-edit-actions">
        <button type="button" className="select-model" disabled={busy || !draft.trim()} onClick={() => onSaveEdit(memory)}>保存修正</button>
        <button type="button" className="text-button muted-button" disabled={busy} onClick={onCancelEdit}>取消</button>
      </div>
    </div> : <p className={`memory-governance-content${hidden ? ' is-hidden' : ''}`}>
      {content || (hidden ? `正文已隐藏（${statusLabel(status)}）` : '暂无正文')}
    </p>}

    <div className="memory-governance-meta">
      <span>{Math.round(Number(memory.confidence || 0) * 100)}% 确信</span>
      <span>{memory.sensitivity || 'S0'}</span>
      <span>{memory.source || 'memory-module'}</span>
      {memory.resourceRevision != null && <span>修订 {memory.resourceRevision}</span>}
    </div>

    {confirmation && status === 'pending_confirmation' && <div className="memory-governance-confirmation">
      <span>这条记忆需要你的确认后才会进入可回忆状态。</span>
      <div className="memory-governance-actions">
        <button type="button" className="select-model" disabled={busy} onClick={() => onConfirm(memory, confirmation)}>确认</button>
        <button type="button" className="text-button muted-button" disabled={busy} onClick={() => onReject(memory, confirmation)}>拒绝</button>
      </div>
    </div>}

    <div className="memory-governance-actions memory-governance-card-actions">
      {status === 'candidate' && <button type="button" className="select-model" disabled={busy} onClick={() => onPromote(memory)}>激活候选</button>}
      {canEdit && !editing && <button type="button" className="text-button" disabled={busy} onClick={() => onStartEdit(memory)}>修正</button>}
      {status === 'active' && <button type="button" className="text-button" disabled={busy} onClick={() => onTogglePin(memory)}>{memory.pinned ? '取消 Pin' : 'Pin'}</button>}
      {!['forgotten', 'revoked', 'deleted'].includes(status) && <button type="button" className="text-button muted-button" disabled={busy} onClick={() => onForget(memory)}>忘记</button>}
      {!['forgotten', 'revoked', 'deleted'].includes(status) && <button type="button" className="text-button muted-button" disabled={busy} onClick={() => onRevoke(memory)}>撤回</button>}
      {status !== 'deleted' && <button type="button" className="text-button danger-button" disabled={busy} onClick={() => onDelete(memory)}>删除</button>}
      {busy && <span className="memory-governance-busy">处理中…</span>}
    </div>
  </article>;
}

export default function MemoryGovernance({ onClose, onChanged }) {
  const [memories, setMemories] = useState([]);
  const [confirmations, setConfirmations] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [memoryResult, confirmationResult] = await Promise.all([
        api('/api/memories?purpose=governance&includeCandidates=true&includeRevoked=true&limit=100'),
        api('/api/confirmations?status=pending&limit=100')
      ]);
      setMemories(asArray(memoryResult));
      setConfirmations(asArray(confirmationResult?.items));
    } catch (err) {
      setError(err.message || '记忆治理数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const confirmationByMemoryId = useMemo(() => new Map(confirmations.map(item => [item.candidateAssertionId, item])), [confirmations]);
  const counts = useMemo(() => memories.reduce((result, item) => {
    const status = item.status || 'unknown';
    result.all += 1;
    result[status] = (result[status] || 0) + 1;
    if (status === 'candidate' || status === 'pending_confirmation') result.action += 1;
    if (['revoked', 'forgotten', 'deleted', 'rejected', 'expired', 'superseded'].includes(status)) result.hidden += 1;
    return result;
  }, { all: 0, action: 0, hidden: 0 }), [memories]);

  const visibleMemories = useMemo(() => memories.filter(item => {
    const status = item.status || 'unknown';
    if (filter === 'needs-action') return status === 'candidate' || status === 'pending_confirmation';
    if (filter === 'active') return status === 'active';
    if (filter === 'hidden') return ['revoked', 'forgotten', 'deleted', 'rejected', 'expired', 'superseded'].includes(status);
    return true;
  }), [filter, memories]);

  const runMutation = async (key, operation) => {
    setBusyKey(key);
    setError('');
    try {
      await operation();
      setEditingId(null);
      setEditingText('');
      await load();
      if (onChanged) await onChanged();
    } catch (err) {
      setError(err.message || '记忆治理操作失败');
    } finally {
      setBusyKey('');
    }
  };

  const startEdit = memory => {
    setEditingId(memory.id);
    setEditingText(memory.summary || '');
    setError('');
  };

  const saveEdit = memory => runMutation(`correct:${memory.id}`, () => api(`/api/memories/${memory.id}/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: createMutationBody('correct', memory.id, memory.resourceRevision, { summary: editingText.trim() })
  }));

  const confirmMemory = (memory, confirmation) => runMutation(`confirm:${memory.id}`, () => api(`/api/confirmations/${confirmation.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: createMutationBody('confirm', confirmation.id, confirmation.resourceRevision)
  }));

  const rejectMemory = (memory, confirmation) => runMutation(`reject:${memory.id}`, () => api(`/api/confirmations/${confirmation.id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: createMutationBody('reject', confirmation.id, confirmation.resourceRevision)
  }));

  const promoteMemory = memory => runMutation(`promote:${memory.id}`, () => api(`/api/memories/${memory.id}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: createMutationBody('promote', memory.id, memory.resourceRevision)
  }));

  const togglePin = memory => runMutation(`pin:${memory.id}`, () => api(`/api/memories/${memory.id}/${memory.pinned ? 'unpin' : 'pin'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: createMutationBody(memory.pinned ? 'unpin' : 'pin', memory.id, memory.resourceRevision)
  }));

  const forgetMemory = memory => {
    if (!window.confirm('忘记后，这条记忆会从可回忆内容中移除，但治理记录仍会保留。继续吗？')) return;
    return runMutation(`forget:${memory.id}`, () => api(`/api/memories/${memory.id}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createMutationBody('forget', memory.id, memory.resourceRevision)
    }));
  };

  const revokeMemory = memory => {
    if (!window.confirm('撤回后，这条记忆会停止参与后续回忆。继续吗？')) return;
    return runMutation(`revoke:${memory.id}`, () => api(`/api/memories/${memory.id}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: createMutationBody('revoke', memory.id, memory.resourceRevision)
    }));
  };

  const deleteMemory = memory => {
    if (!window.confirm('删除后，这条记忆将从当前用户数据中移除，无法通过此面板恢复。继续吗？')) return;
    return runMutation(`delete:${memory.id}`, () => api(`/api/memories/${memory.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: createMutationBody('delete', memory.id, memory.resourceRevision)
    }));
  };

  const exportMemories = async () => {
    setBusyKey('export');
    setError('');
    try {
      const payload = await api('/api/memories/export');
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'cochpia-memories.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || '记忆导出失败');
    } finally {
      setBusyKey('');
    }
  };

  return <div className="settings-backdrop memory-governance-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-panel memory-governance-panel" role="dialog" aria-modal="true" aria-labelledby="memory-governance-title">
      <header className="settings-header memory-governance-header">
        <div>
          <p className="eyebrow">MEMORY GOVERNANCE</p>
          <h2 id="memory-governance-title">记忆治理</h2>
          <p>查看并决定哪些内容可以留在共同空间。已撤回或忘记的正文不会在这里重新展示。</p>
        </div>
        <div className="memory-governance-header-actions">
          <button type="button" className="text-button" disabled={loading || busyKey === 'export'} onClick={exportMemories}>导出</button>
          <button type="button" className="text-button" disabled={loading} onClick={load}>刷新</button>
          <button type="button" className="icon-button" aria-label="关闭记忆治理" title="关闭记忆治理" onClick={onClose}>×</button>
        </div>
      </header>

      {error && <div className="memory-governance-error" role="alert">{error}<button type="button" className="text-button" onClick={() => setError('')}>关闭</button></div>}

      <div className="memory-governance-toolbar" aria-label="记忆筛选">
        {[['all', `全部 ${counts.all}`], ['needs-action', `待处理 ${counts.action}`], ['active', `已激活 ${counts.active || 0}`], ['hidden', `已撤回/忘记 ${counts.hidden}`]].map(([value, label]) => <button type="button" key={value} className={`memory-governance-filter${filter === value ? ' active' : ''}`} onClick={() => setFilter(value)}>{label}</button>)}
        <span className="memory-governance-pending">待确认请求 {confirmations.length}</span>
      </div>

      <div className="memory-governance-list">
        {loading ? <p className="empty-detail">正在读取记忆治理状态…</p> : visibleMemories.length === 0 ? <p className="empty-detail">当前筛选下没有记忆。</p> : visibleMemories.map(memory => <MemoryCard
          key={memory.id}
          memory={memory}
          confirmation={confirmationByMemoryId.get(memory.id)}
          busy={busyKey.endsWith(`:${memory.id}`) || (memory.status === 'pending_confirmation' && busyKey.startsWith('confirm:'))}
          editing={editingId === memory.id}
          draft={editingText}
          onStartEdit={startEdit}
          onCancelEdit={() => { setEditingId(null); setEditingText(''); }}
          onDraftChange={setEditingText}
          onSaveEdit={saveEdit}
          onConfirm={confirmMemory}
          onReject={rejectMemory}
          onPromote={promoteMemory}
          onTogglePin={togglePin}
          onForget={forgetMemory}
          onRevoke={revokeMemory}
          onDelete={deleteMemory}
        />)}
      </div>
    </section>
  </div>;
}
