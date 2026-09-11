// Overlay detail panels, split out of App() (R-020 stage 4).
//
// Only the profile panel was moved. It is the one panel an end-to-end check
// actually opens (e2e S9), which matters because a missing prop here does not
// fail the build -- it throws at render time inside the panel.
//
// The growth / history panels live behind the inspector floating window; they were
// moved only after e2e S11/S12 gave that window an entry point (查看共同状态 ->
// 查看时间线 / 查看版本), so the extraction is actually verified.
//
// The settings / task / event panels still stay in main.jsx: no automated check
// opens them, and extracting a panel I cannot render is how a refactor becomes a
// silent break waiting for a user to click. Cover them first.

import React from 'react';
import FeatherIcon from '../icons/FeatherIcon';
import CharacterProfile from '../profile/CharacterProfile';
import AvatarPicker from '../profile/AvatarPicker';

// Extracted verbatim; the only edit is setProfileOpen(false) -> onClose().
export function ProfilePanel({ pendingApproval, respondApproval, onClose }) {
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title"><CharacterProfile onClose={() => onClose()} /></section></div>;
}

// Extracted verbatim; the only edit is setGrowthOpen(false) -> onClose().
export function GrowthPanel({ growthEvidence, reviewingEvidence, reviewAllEvidence, reviewEvidence, traitLabel, onClose }) {
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="growth-title"><header className="settings-header"><div><p className="eyebrow">AUDITABLE GROWTH</p><h2 id="growth-title">成长证据时间线</h2><p>确认证据后，对应人格维度会真实更新并生成新版本，随时可回滚。</p></div><button className="icon-button" aria-label="关闭成长时间线" title="关闭成长时间线" onClick={() => onClose()}><FeatherIcon name="x" size={16} /></button></header><div className="growth-actions"><span className="growth-pending">待确认 {growthEvidence.filter(item => item.status === 'draft' || !item.status).length} 条 · 已确认 {growthEvidence.filter(item => item.status === 'confirmed').length} 条 · 已驳回 {growthEvidence.filter(item => item.status === 'rejected').length} 条</span>{growthEvidence.some(item => item.status === 'draft' || !item.status) && <div className="growth-batch"><button type="button" className="select-model" disabled={reviewingEvidence !== null} onClick={() => reviewAllEvidence('confirmed')}>{reviewingEvidence === 'all' ? '处理中…' : '全部确认采纳'}</button><button type="button" className="text-button muted-button" disabled={reviewingEvidence !== null} onClick={() => reviewAllEvidence('rejected')}>全部驳回</button></div>}</div><div className="timeline">{growthEvidence.length === 0 ? <p className="empty-detail">暂时没有成长证据，聊几句后会自动生成。</p> : growthEvidence.map(item => { const isDraft = item.status === 'draft' || !item.status; const busy = reviewingEvidence === item.id; const delta = Number(item.proposedChange?.delta); return <article className={`timeline-item evidence-${item.status || 'draft'}`} key={item.id}><div className="timeline-marker" /><div><div className="timeline-meta"><span className={`evidence-status evidence-${item.status || 'draft'}`}>{item.status === 'confirmed' ? '已确认' : item.status === 'rejected' ? '已驳回' : '待确认'}</span><time>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></div><h3>{item.claim}</h3><p>{item.evidence}</p>{item.proposedChange?.traitKey && <div className="evidence-delta"><span>{traitLabel(item.proposedChange.traitKey)}</span><b className={delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}>{delta > 0 ? '+' : ''}{delta.toFixed(3)}</b></div>}<small>{item.sourceMessageId ? `来源消息：${String(item.sourceMessageId).slice(0, 8)}…` : '暂无来源消息'}</small>{isDraft && <div className="evidence-actions"><button type="button" className="select-model" disabled={busy || reviewingEvidence !== null} onClick={() => reviewEvidence(item.id, 'confirmed')}>{busy ? '处理中…' : '确认采纳'}</button><button type="button" className="text-button muted-button" disabled={busy || reviewingEvidence !== null} onClick={() => reviewEvidence(item.id, 'rejected')}>驳回</button></div>}</div></article>; })}</div></section></div>;
}

// Extracted verbatim; the only edit is setHistoryOpen(false) -> onClose().
export function HistoryPanel({ currentVersion, previousVersion, versionChanges, traitLabel, onClose }) {
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="history-title"><header className="settings-header"><div><p className="eyebrow">PERSONALITY HISTORY</p><h2 id="history-title">人格版本差异</h2><p>{currentVersion && previousVersion ? `v${previousVersion.version} → v${currentVersion.version}` : '等待第二个版本后显示差异'}</p></div><button className="icon-button" aria-label="关闭人格版本" title="关闭人格版本" onClick={() => onClose()}><FeatherIcon name="x" size={16} /></button></header>{currentVersion && previousVersion ? <div className="version-diff">{versionChanges.map(trait => <div className="diff-row" key={trait.key}><div><strong>{trait.label}</strong><span>{Math.round(trait.previous * 100)}% → {Math.round(trait.value * 100)}%</span></div><b className={trait.delta > 0 ? 'delta-up' : trait.delta < 0 ? 'delta-down' : ''}>{trait.delta > 0 ? '+' : ''}{Math.round(trait.delta * 100)}%</b></div>)}</div> : <p className="empty-detail">当前只有一个人格版本，完成下一次对话后会生成可比较的版本。</p>}</section></div>;
}
