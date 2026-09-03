import React, { useEffect, useRef, useState } from 'react';
import FeatherIcon from '../icons/FeatherIcon';
import { fileToDataUrl } from '../profile/image';
import { agentInitial, asArray, readAccounts, companionIntents } from '../lib/utils';
import { api } from '../api';

export function CompanionIntentBar({ mode, intent, onChange }) {
  if (mode !== 'companion') return null;
  const [collapsed, setCollapsed] = useState(true);
  if (collapsed) return <button type="button" className="companion-intent-collapsed" onClick={() => setCollapsed(false)} title="展开陪伴方式设置">陪伴设定</button>;
  return <div className="companion-intent-bar" role="group" aria-label="陪伴方式"><span className="companion-intent-label">本条回复方式</span><div className="companion-intent-options">{companionIntents.map(item => <button key={item.id} type="button" className={`companion-intent ${intent === item.id ? 'active' : ''}`} aria-pressed={intent === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div><button type="button" className="companion-intent-close" onClick={() => setCollapsed(true)} aria-label="收起陪伴方式设置" title="收起"><FeatherIcon name="x" size={14} /></button></div>;
}

export function GroupChatIdentity({ session, agents, onOpen }) {
  if (!session || session.kind !== 'group') return null;
  const members = agents.filter(agent => (session.agentIds || []).includes(agent.id));
  return <button type="button" className="group-chat-identity" onClick={onOpen} aria-label="打开群聊信息" title="打开群聊信息">
    <span className="group-chat-avatar">{session.avatar || '群'}</span>
    <span><strong>{session.title}</strong><small>{members.length + 1} 位成员{session.description ? ` · ${session.description}` : ''}</small></span>
  </button>;
}

export function WorkspaceOverflow({ isGroup, onGroupInfo, onState, onCloseState }) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const triggerRef = useRef(null);
  const updateMenuPosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition({
      top: rect.bottom + 8,
      left: Math.max(8, Math.min(rect.right - 150, window.innerWidth - 158))
    });
  };
  useEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open]);
  return <div className="workspace-overflow">
    <button ref={triggerRef} type="button" className="workspace-overflow-trigger" onClick={() => setOpen(current => !current)} aria-expanded={open} aria-label="更多聊天操作" title="更多聊天操作"><FeatherIcon name="moreHorizontal" size={20} /></button>
    {open && <div className="workspace-overflow-menu workspace-overflow-menu-floating" style={menuPosition || undefined} role="menu">
      {isGroup && <button type="button" onClick={() => { setOpen(false); onGroupInfo(); }}>群聊信息</button>}
      <button type="button" onClick={() => { setOpen(false); onState(); }}>共同状态</button>
      <button type="button" onClick={() => { setOpen(false); onCloseState(); }}>收起浮动窗口</button>
    </div>}
  </div>;
}

export function AgentInfoCard({ agent, onSave, onRemove }) {
  const [draft, setDraft] = useState({ role: agent.role || agent.relationship || '朋友', tone: agent.tone || '自然、温和', persona: agent.persona || '', memoryNotes: agent.memoryNotes || '' });
  const [saving, setSaving] = useState(false);
  const save = async event => {
    event.preventDefault();
    setSaving(true);
    try { await onSave(agent.id, draft); } finally { setSaving(false); }
  };
  return <details className="agent-detail-card">
    <summary><span className="agent-detail-avatar">{agentInitial(agent)}</span><span><strong>{agent.name}</strong><small>{draft.role} · {draft.tone}</small></span><span className="agent-detail-chevron">⌄</span></summary>
    <form className="agent-detail-form" onSubmit={save}>
      <label>角色设定<input value={draft.role} onChange={event => setDraft(current => ({ ...current, role: event.target.value }))} placeholder="例如：观察者、朋友、向导" /></label>
      <label>说话语气<input value={draft.tone} onChange={event => setDraft(current => ({ ...current, tone: event.target.value }))} placeholder="例如：温和、简洁、幽默" /></label>
      <label>人格设定<textarea value={draft.persona} onChange={event => setDraft(current => ({ ...current, persona: event.target.value }))} rows="3" placeholder="这个 Agent 如何理解自己,如何与用户相处…" /></label>
      <label>记忆备注<textarea value={draft.memoryNotes} onChange={event => setDraft(current => ({ ...current, memoryNotes: event.target.value }))} rows="3" placeholder="只记录希望这个 Agent 长期保留的内容…" /></label>
      <div className="agent-detail-actions"><button type="submit" className="select-model" disabled={saving}>{saving ? '保存中…' : '保存设定'}</button><button type="button" className="text-button danger-button" onClick={() => onRemove(agent.id)}>移出群聊</button></div>
    </form>
  </details>;
}

export function GroupInfoPanel({ session, agents, open, onClose, onSave, onInvite, onRemove, onAgentSave }) {
  const [title, setTitle] = useState(session?.title || '群聊');
  const [description, setDescription] = useState(session?.description || '');
  useEffect(() => { setTitle(session?.title || '群聊'); setDescription(session?.description || ''); }, [session?.id, session?.title, session?.description]);
  if (!session || session.kind !== 'group') return null;
  const members = agents.filter(agent => (session.agentIds || []).includes(agent.id));
  const invitees = agents.filter(agent => !(session.agentIds || []).includes(agent.id));
  const saveGroup = async event => { event.preventDefault(); await onSave({ title, description }); };
  return <>
    {open && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel group-info-panel" role="dialog" aria-modal="true" aria-labelledby="group-info-title">
      <header className="settings-header"><div><p className="eyebrow">GROUP SPACE</p><h2 id="group-info-title">群聊信息</h2><p>{members.length} 位 Agent · 你也在其中</p></div><button className="icon-button" aria-label="关闭群聊信息" title="关闭群聊信息" onClick={onClose}><FeatherIcon name="x" size={16} /></button></header>
      <form className="group-meta-form" onSubmit={saveGroup}><label>群名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength="80" /></label><label>群简介<textarea value={description} onChange={event => setDescription(event.target.value)} rows="2" maxLength="300" placeholder="这个群一起做什么,保持什么氛围…" /></label><button className="select-model" type="submit">保存群资料</button></form>
      <div className="group-section"><div className="section-heading"><span>群成员</span><small>{members.length} 人</small></div>{members.length ? members.map(agent => <AgentInfoCard key={agent.id} agent={agent} onSave={onAgentSave} onRemove={onRemove} />) : <p className="empty-detail">还没有 Agent 成员。</p>}</div>
      <div className="group-section"><div className="section-heading"><span>邀请 Agent</span><small>点击加入当前群聊</small></div>{invitees.length ? <div className="invite-list">{invitees.map(agent => <button type="button" className="invite-row" key={agent.id} onClick={() => onInvite(agent.id)}><span className="agent-detail-avatar">{agentInitial(agent)}</span><span><strong>{agent.name}</strong><small>{agent.role || agent.relationship || '朋友'}</small></span><b>＋</b></button>)}</div> : <p className="empty-detail">所有 Agent 都已在群里。</p>}</div>
    </section></div>}
  </>;
}

export function AgentCard({ agent, onChat, onEdit, onDelete, onView }) {
  const displayName = agent.remark || agent.name;
  return <div className="agent-card" style={{ order: agent.primary ? -2 : agent.pinned ? -1 : 0 }}>
    <div className="agent-card-banner" aria-hidden="true" />
    <div className="agent-card-body">
      <div className="agent-card-head">
        <button type="button" className="agent-card-avatar agent-card-avatar-btn" onClick={() => onView(agent)} aria-label="查看资料" title="查看资料">{agent.avatarImage ? <img src={agent.avatarImage} alt="" /> : agentInitial(agent)}</button>
        <div className="agent-card-id"><strong>{agent.primary && <span className="agent-badge" title="主陪伴">主</span>}{agent.pinned && <span className="agent-badge" title="已置顶">📌</span>}{displayName}</strong><small>{agent.role || agent.relationship || '朋友'}{agent.remark ? ` · ${agent.name}` : ''}{agent.muted ? ' · 🔕' : ''}</small></div>
        <span className="agent-card-model">{agent.model || agent.provider || '默认'}</span>
      </div>
      <p className="agent-card-signature">{agent.signature || '（还没有个性签名）'}</p>
      {(agent.tags || []).length > 0 && <div className="agent-tags">{agent.tags.map(tag => <span className="agent-tag" key={tag}>{tag}</span>)}</div>}
      <div className="agent-card-info"><div className="agent-card-row"><span>说话语气</span><b>{agent.tone || '自然、温和'}</b></div></div>
      <div className="agent-card-actions"><button type="button" className="select-model" onClick={() => onChat(agent)}>发消息</button><button type="button" className="text-button" onClick={() => onEdit(agent)}>编辑</button><button type="button" className="text-button danger-button" onClick={() => onDelete(agent)}>删除</button></div>
    </div>
  </div>;
}

export function AgentFormModal({ agent, models, onClose, onSave }) {
  const [draft, setDraft] = useState({ name: agent?.name || '', avatarImage: agent?.avatarImage || '', remark: agent?.remark || '', role: agent?.role || '朋友', relationship: agent?.relationship || '朋友', tone: agent?.tone || '自然、温和', signature: agent?.signature || '', persona: agent?.persona || '', provider: agent?.provider || '', model: agent?.model || '', memoryNotes: agent?.memoryNotes || '', tags: agent?.tags || [], primary: agent?.primary || false });
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const runImport = async () => {
    const text = importText.trim();
    if (!text || importing) return;
    setImporting(true);
    try {
      const result = await api('/api/agents/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const parsed = result?.draft || {};
      const patch = {};
      for (const key of ['name', 'remark', 'role', 'relationship', 'tone', 'signature', 'persona', 'memoryNotes']) { if (parsed[key]) patch[key] = parsed[key]; }
      if (Array.isArray(parsed.tags) && parsed.tags.length) patch.tags = parsed.tags;
      if (Object.keys(patch).length) setDraft(current => ({ ...current, ...patch }));
      setImportText('');
    } catch (error) { window.alert(error.message || '解析失败，请稍后重试'); }
    finally { setImporting(false); }
  };
  const avatarFileRef = useRef(null);
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const handleAvatarFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { set('avatarImage', await fileToDataUrl(file, 256, 0.85)); } catch { /* 忽略无效图片 */ }
    event.target.value = '';
  };
  const readyProviders = asArray(models?.providers).filter(item => item.ready);
  const selectedProviderInfo = readyProviders.find(item => item.provider === draft.provider) || readyProviders[0] || null;
  const submit = async event => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    await onSave({ ...draft, name: draft.name.trim(), provider: draft.provider || selectedProviderInfo?.provider || '', model: draft.model || selectedProviderInfo?.model || selectedProviderInfo?.suggestedModels?.[0] || '' });
  };
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel agent-form-panel" role="dialog" aria-modal="true" aria-labelledby="agent-form-title" onClick={event => event.stopPropagation()}><header className="settings-header"><div><p className="eyebrow">AGENT CARD</p><h2 id="agent-form-title">{agent ? '编辑角色' : '新建角色'}</h2><p>为这个 Agent 设定角色、人格与模型。</p></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><FeatherIcon name="x" size={16} /></button></header><form className="agent-form" onSubmit={submit}><details className="agent-import"><summary>导入角色设定（自动识别）</summary><div className="agent-import-body"><textarea value={importText} onChange={event => setImportText(event.target.value)} rows="4" placeholder="粘贴一段角色设定原文，例如：名字、性格、说话语气、背景故事…" /><button type="button" className="text-button" onClick={runImport} disabled={importing || !importText.trim()}>{importing ? '识别中…' : '自动识别并填入'}</button></div></details><label>名字<input value={draft.name} onChange={event => set('name', event.target.value)} maxLength="40" placeholder="例如：观察者" /></label><label>备注名<input value={draft.remark} onChange={event => set('remark', event.target.value)} maxLength="40" placeholder="给这个 Agent 起个备注（可选）" /></label><label>头像图片<span className="agent-avatar-upload">{draft.avatarImage ? <img src={draft.avatarImage} alt="" /> : <span>未设置</span>}<button type="button" className="text-button" onClick={() => avatarFileRef.current?.click()}>上传图片</button>{draft.avatarImage && <button type="button" className="text-button muted-button" onClick={() => set('avatarImage', '')}>移除</button>}</span><input ref={avatarFileRef} type="file" accept="image/*" hidden onChange={handleAvatarFile} /></label><label className="agent-setting-row"><span>主陪伴</span><input type="checkbox" checked={Boolean(draft.primary)} onChange={event => set('primary', event.target.checked)} /></label><label>角色定位<input value={draft.role} onChange={event => set('role', event.target.value)} maxLength="80" placeholder="例如：朋友、向导、观察者" /></label><label>关系<input value={draft.relationship} onChange={event => set('relationship', event.target.value)} maxLength="40" placeholder="例如：朋友、搭档、恋人" /></label><label>标签<input value={(draft.tags || []).join('、')} onChange={event => set('tags', event.target.value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean).slice(0, 10))} maxLength="200" placeholder="逗号分隔，如：温柔、幽默" /></label><label>说话语气<input value={draft.tone} onChange={event => set('tone', event.target.value)} maxLength="120" placeholder="例如：温和、简洁、幽默" /></label><label>个性签名<input value={draft.signature} onChange={event => set('signature', event.target.value)} maxLength="200" placeholder="一句话介绍，显示在角色卡上…" /></label><label>人格设定<textarea value={draft.persona} onChange={event => set('persona', event.target.value)} rows="4" placeholder="这个 Agent 如何理解自己、如何与你相处…" /></label><label>记忆备注<textarea value={draft.memoryNotes} onChange={event => set('memoryNotes', event.target.value)} rows="3" placeholder="只记录希望这个 Agent 长期保留的内容…" /></label><label>模型<select value={draft.provider} onChange={event => set('provider', event.target.value)}>{readyProviders.map(item => <option key={item.provider} value={item.provider}>{item.label}</option>)}</select></label><div className="agent-form-actions"><button className="select-model" type="submit" disabled={!draft.name.trim()}>{agent ? '保存角色' : '创建角色'}</button></div></form></section></div>;
}

export function AgentProfileModal({ agent, onClose, onChat, onEdit, onPatch }) {
  if (!agent) return null;
  const displayName = <>{agent.primary && <span className="agent-badge" title="主陪伴">主</span>}{agent.remark || agent.name}</>;
  const primarySetting = <label className="agent-setting-row"><span>主陪伴</span><input type="checkbox" checked={Boolean(agent.primary)} onChange={event => onPatch({ primary: event.target.checked })} /></label>;
  const addTag = () => {
    const tag = String(window.prompt('标签名（最多 10 个）') || '').trim().slice(0, 30);
    if (tag && !(agent.tags || []).includes(tag)) onPatch({ tags: [...(agent.tags || []), tag] });
  };
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel agent-profile-panel" role="dialog" aria-modal="true" aria-labelledby="agent-profile-title" onClick={event => event.stopPropagation()}><div className="agent-profile-banner" aria-hidden="true" /><div className="agent-profile-head"><span className="agent-profile-avatar">{agent.avatarImage ? <img src={agent.avatarImage} alt="" /> : agentInitial(agent)}</span><div className="agent-profile-title"><h2 id="agent-profile-title">{agent.pinned && <span className="agent-badge" title="已置顶">📌</span>}{displayName}</h2>{agent.remark && <p className="agent-profile-origin">原名 · {agent.name}</p>}<p className="agent-profile-signature">{agent.signature || '（还没有个性签名）'}</p></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><FeatherIcon name="x" size={16} /></button></div><div className="agent-profile-info">{agent.role && <div className="agent-profile-row"><span>角色定位</span><b>{agent.role}</b></div>}{agent.relationship && <div className="agent-profile-row"><span>关系</span><b>{agent.relationship}</b></div>}{agent.tone && <div className="agent-profile-row"><span>说话语气</span><b>{agent.tone}</b></div>}{(agent.provider || agent.model) && <div className="agent-profile-row"><span>模型</span><b>{agent.model || agent.provider || '默认'}</b></div>}{agent.persona && <div className="agent-profile-row agent-profile-row-block"><span>人格设定</span><p>{agent.persona}</p></div>}{agent.memoryNotes && <div className="agent-profile-row agent-profile-row-block"><span>记忆备注</span><p>{agent.memoryNotes}</p></div>}</div><div className="agent-profile-settings"><div className="section-heading"><span>关系设定</span><small>单边设置，不影响 Agent 本身</small></div><label className="agent-setting-row"><span>置顶</span><input type="checkbox" checked={Boolean(agent.pinned)} onChange={event => onPatch({ pinned: event.target.checked })} /></label>{primarySetting}<label className="agent-setting-row"><span>免打扰</span><input type="checkbox" checked={Boolean(agent.muted)} onChange={event => onPatch({ muted: event.target.checked })} /></label><div className="agent-setting-row"><span>标签</span><div className="agent-tags">{(agent.tags || []).map(tag => <span className="agent-tag" key={tag}>{tag}<button type="button" aria-label={`移除标签 ${tag}`} title="移除标签" onClick={() => onPatch({ tags: agent.tags.filter(item => item !== tag) })}>×</button></span>)}<button type="button" className="agent-tag agent-tag-add" onClick={addTag}>＋ 添加</button></div></div></div><div className="agent-profile-actions"><button type="button" className="select-model" onClick={() => onChat(agent)}>发消息</button><button type="button" className="select-model" onClick={() => onEdit(agent)}>编辑</button></div></section></div>;
}

export function GroupCreateModal({ agents, onClose, onCreate }) {
  const [title, setTitle] = useState('群聊');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState([]);
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const submit = async event => {
    event.preventDefault();
    if (!selected.length) return;
    await onCreate({ title: title.trim() || '群聊', description: description.trim(), agentIds: selected });
  };
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="group-create-title" onClick={event => event.stopPropagation()}><header className="settings-header"><div><p className="eyebrow">GROUP CHAT</p><h2 id="group-create-title">发起群聊</h2><p>选择加入群聊的 Agent。</p></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><FeatherIcon name="x" size={16} /></button></header><form className="group-meta-form" onSubmit={submit}><label>群名称<input value={title} onChange={event => setTitle(event.target.value)} maxLength="80" /></label><label>群简介<textarea value={description} onChange={event => setDescription(event.target.value)} rows="2" maxLength="300" /></label><div className="group-section"><div className="section-heading"><span>选择成员</span><small>{selected.length} 位</small></div>{agents.length ? <div className="invite-list">{agents.map(agent => <button type="button" className={`invite-row ${selected.includes(agent.id) ? 'active' : ''}`} key={agent.id} onClick={() => toggle(agent.id)}><span className="agent-detail-avatar">{agentInitial(agent)}</span><span><strong>{agent.name}</strong><small>{agent.role || agent.relationship || '朋友'}</small></span><b>{selected.includes(agent.id) ? '✓' : '＋'}</b></button>)}</div> : <p className="empty-detail">还没有可选的 Agent，请先创建角色。</p>}</div><button className="select-model" type="submit" disabled={!selected.length}>创建群聊</button></form></section></div>;
}

export function AccountSwitcherModal({ user, onClose, onSwitch, onAdd }) {
  const accounts = readAccounts();
  const currentEmail = user?.email;
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel account-switcher-panel" role="dialog" aria-modal="true" aria-labelledby="account-switcher-title" onClick={event => event.stopPropagation()}><header className="settings-header"><div><p className="eyebrow">ACCOUNT</p><h2 id="account-switcher-title">切换账号</h2><p>选择一个账号登录，或添加新账号。</p></div><button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><FeatherIcon name="x" size={16} /></button></header><div className="account-list">{accounts.map(account => <div className={`account-row ${account.email === currentEmail ? 'current' : ''}`} key={account.email}><span className="account-avatar">{account.name ? account.name.charAt(0).toUpperCase() : '?'}</span><div className="account-info"><strong>{account.name}</strong><small>{account.email}</small></div>{account.email === currentEmail ? <span className="account-current-badge">当前</span> : <button type="button" className="select-model" onClick={() => onSwitch(account.email)}>切换</button>}</div>)}{accounts.length === 0 && <p className="empty-detail">还没有登录记录。</p>}</div><div className="account-actions"><button type="button" className="select-model" onClick={onAdd}>＋ 添加账号</button></div></section></div>;
}
