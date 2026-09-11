import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, supabase, apiBase } from './api';
// R-020 stage 3: one shared mode-switch detector. The client uses it to decide
// which chat route a message belongs to, so it can never disagree with the
// server about what counts as a mode command.
import { isWorkRouteMessage } from '../../server/mode-switch.js';
import './styles.css';
import { MaterialPreview } from './material/MaterialPreview';
import { MaterialProvider } from './material/MaterialProvider';
import { FloatingWindow, WindowManagerProvider, useWindowManager } from './windows/WindowManager';
import { SettingsWindow } from './workspace/SettingsWindow';
import { WorkspacePreferencesProvider, useWorkspacePreferences } from './workspace/WorkspacePreferencesProvider';
import { BackgroundLayer } from './workspace/BackgroundLayer';
import { AudioProvider, useAudio } from './audio/AudioProvider';
import { VoiceProvider, useVoice } from './audio/VoiceProvider';
import { MusicProvider } from './audio/MusicProvider';
import { MusicWindow } from './audio/MusicWindow';
import { I18nProvider } from './i18n/I18nProvider';
import { TimeProvider, useTime } from './time/TimeProvider';
import { ProfileProvider, useProfile } from './profile/ProfileProvider';
import CharacterProfile from './profile/CharacterProfile';
import AvatarPicker from './profile/AvatarPicker';
import FeatherIcon from './icons/FeatherIcon';
import { asArray, describeModelError, providerModelOptions, splitSegments, takeSegment, dateLabel } from './chat/message-utils.js';
import { GrowthPanel, HistoryPanel, ProfilePanel } from './panels/DetailPanels.jsx';

// Pure message helpers moved to ./chat/message-utils.js (R-020 stage 4 split).

const companionIntents = [
  { id: 'listen', label: '听我说' },
  { id: 'comfort', label: '安慰我' },
  { id: 'advice', label: '给建议' },
  { id: 'accompany', label: '陪我做' },
  { id: 'quiet', label: '安静陪伴' }
];

function CompanionIntentBar({ mode, intent, onChange }) {
  if (mode !== 'companion') return null;
  const [collapsed, setCollapsed] = useState(true);
  if (collapsed) return <button type="button" className="companion-intent-collapsed" onClick={() => setCollapsed(false)} title="展开陪伴方式设置">陪伴设定</button>;
  return <div className="companion-intent-bar" role="group" aria-label="陪伴方式"><span className="companion-intent-label">本条回复方式</span><div className="companion-intent-options">{companionIntents.map(item => <button key={item.id} type="button" className={`companion-intent ${intent === item.id ? 'active' : ''}`} aria-pressed={intent === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div><button type="button" className="companion-intent-close" onClick={() => setCollapsed(true)} aria-label="收起陪伴方式设置" title="收起"><FeatherIcon name="x" size={14} /></button></div>;
}

function GroupChatIdentity({ session, agents, onOpen }) {
  if (!session || session.kind !== 'group') return null;
  const members = agents.filter(agent => (session.agentIds || []).includes(agent.id));
  return <button type="button" className="group-chat-identity" onClick={onOpen} aria-label="打开群聊信息" title="打开群聊信息">
    <span className="group-chat-avatar">{session.avatar || '群'}</span>
    <span><strong>{session.title}</strong><small>{members.length + 1} 位成员{session.description ? ` · ${session.description}` : ''}</small></span>
  </button>;
}

function AgentInfoCard({ agent, onSave, onRemove }) {
  const [draft, setDraft] = useState({ role: agent.role || agent.relationship || '朋友', tone: agent.tone || '自然、温和', persona: agent.persona || '', memoryNotes: agent.memoryNotes || '' });
  const [saving, setSaving] = useState(false);
  const save = async event => {
    event.preventDefault();
    setSaving(true);
    try { await onSave(agent.id, draft); } finally { setSaving(false); }
  };
  return <details className="agent-detail-card">
    <summary><span className="agent-detail-avatar">{agent.avatar || '✦'}</span><span><strong>{agent.name}</strong><small>{draft.role} · {draft.tone}</small></span><span className="agent-detail-chevron">⌄</span></summary>
    <form className="agent-detail-form" onSubmit={save}>
      <label>角色设定<input value={draft.role} onChange={event => setDraft(current => ({ ...current, role: event.target.value }))} placeholder="例如：观察者、朋友、向导" /></label>
      <label>说话语气<input value={draft.tone} onChange={event => setDraft(current => ({ ...current, tone: event.target.value }))} placeholder="例如：温和、简洁、幽默" /></label>
      <label>人格设定<textarea value={draft.persona} onChange={event => setDraft(current => ({ ...current, persona: event.target.value }))} rows="3" placeholder="这个 Agent 如何理解自己,如何与用户相处…" /></label>
      <label>记忆备注<textarea value={draft.memoryNotes} onChange={event => setDraft(current => ({ ...current, memoryNotes: event.target.value }))} rows="3" placeholder="只记录希望这个 Agent 长期保留的内容…" /></label>
      <div className="agent-detail-actions"><button type="submit" className="select-model" disabled={saving}>{saving ? '保存中…' : '保存设定'}</button><button type="button" className="text-button danger-button" onClick={() => onRemove(agent.id)}>移出群聊</button></div>
    </form>
  </details>;
}

function GroupInfoPanel({ session, agents, open, onClose, onSave, onInvite, onRemove, onAgentSave, onAgentRemove }) {
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
      <div className="group-section"><div className="section-heading"><span>邀请 Agent</span><small>点击加入当前群聊</small></div>{invitees.length ? <div className="invite-list">{invitees.map(agent => <button type="button" className="invite-row" key={agent.id} onClick={() => onInvite(agent.id)}><span className="agent-detail-avatar">{agent.avatar || '✦'}</span><span><strong>{agent.name}</strong><small>{agent.role || agent.relationship || '朋友'}</small></span><b>＋</b></button>)}</div> : <p className="empty-detail">所有 Agent 都已在群里。</p>}</div>
    </section></div>}
  </>;
}

function App() {
  const { state: workspacePreferences, setSetting: setWorkspaceSetting } = useWorkspacePreferences();
  const { profile } = useProfile();
  const { formatTime, formatDate } = useTime();
  const workspaceClock = <time className="workspace-clock" dateTime={new Date().toISOString()}>{workspacePreferences.time.showDate && <span>{formatDate()}</span>}<b>{formatTime()}</b></time>;
  const { playUiSound } = useAudio();
  const { state: windowState, restoreWindow, focusWindow, closeWindow } = useWindowManager();
  const { listening, interimText, finalText, speaking, error: voiceError, recognitionSupported, ttsSupported, toggleListening, setFinalText, speak, stopSpeaking, clearError } = useVoice();
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authAction, setAuthAction] = useState('sign-in');
  const [authNotice, setAuthNotice] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('welcome');
  const [messages, setMessages] = useState([]);
  const [memory, setMemory] = useState({ count: 0, memories: [] });
  const [personality, setPersonality] = useState(null);
  const [growthEvidence, setGrowthEvidence] = useState([]);
  const [personalityHistory, setPersonalityHistory] = useState([]);
  const [models, setModels] = useState({ defaultProvider: 'mock', providers: [] });
  const [mode, setMode] = useState('companion');
  const [companionIntent, setCompanionIntent] = useState('listen');
  const [toolEvents, setToolEvents] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState('mock');
  const [selectedModel, setSelectedModel] = useState('mock');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [tests, setTests] = useState({});
  const [actualModel, setActualModel] = useState({ provider: '', model: '' });
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingText, setEditingText] = useState('');
  const [growthOpen, setGrowthOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reviewingEvidence, setReviewingEvidence] = useState(null);
  const conversationRef = useRef(null);
  const nearBottomRef = useRef(true);
  const streamStateRef = useRef({ currentId: null, buffer: '', pausing: false, timer: null, counter: 0 });
  // R-020 stage 3.5: the stop button needs to reach the run that is currently
  // streaming, and to break the in-flight fetch locally. The server refuses to
  // commit a cancelled turn (turn-stream.js aborts generation), so cancelling
  // never leaves a half-written reply behind.
  const streamRunRef = useRef({ runId: null, workMode: false, controller: null, cancelled: false });
  const [jumpToBottom, setJumpToBottom] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [channel, setChannel] = useState('默认');
  const [channels, setChannels] = useState([]);
  const [atmosphere, setAtmosphere] = useState('');
  const [atmospherePresets, setAtmospherePresets] = useState([]);
  const [persona, setPersona] = useState('');
  const [personaDraft, setPersonaDraft] = useState('');
  const [agents, setAgents] = useState([]);
  const [agentDraft, setAgentDraft] = useState({ name: '', persona: '', provider: '', model: '', avatar: '✦' });
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  // Legacy task/calendar state is retained only to keep old imported layouts inert until redesign.
  const [eventOpen, setEventOpen] = useState(false);
  const [events] = useState([]);
  const [newEvent, setNewEvent] = useState({ title: '', date: '', type: 'plan', note: '' });
  const [page, setPageState] = useState('splash');
  const setPage = nextPage => setPageState(currentPage => currentPage === nextPage && currentPage !== 'splash' ? 'chat' : nextPage);
  const [minimized, setMinimized] = useState(false);
  const [autoRead, setAutoRead] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const autoReadRef = useRef(false);
  const wasListeningRef = useRef(false);

  const toggleAutoRead = () => {
    const next = !autoRead;
    autoReadRef.current = next;
    setAutoRead(next);
    if (!next) { stopSpeaking(); setSpeakingId(null); }
  };

  // 语音识别错误 → 复用全局 toast
  useEffect(() => {
    if (voiceError) { setError(voiceError); clearError(); }
  }, [voiceError, clearError]);

  // 语音输入结束（手动停止或自动停止）→ 把识别到的最终文本回填到输入框
  useEffect(() => {
    const wasListening = wasListeningRef.current;
    wasListeningRef.current = listening;
    if (wasListening && !listening && finalText.trim()) {
      setInput(current => {
        const base = current.trim();
        const addition = finalText.trim();
        return `${base}${base ? ' ' : ''}${addition}`;
      });
      setFinalText('');
    }
  }, [listening, finalText, setFinalText]);

  const toggleSpeak = item => {
    const full = messages.find(message => message.id === item.id);
    const text = String(full?.content || item.content || '').trim();
    if (!text) return;
    if (speakingId === item.id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    stopSpeaking();
    speak(text, () => setSpeakingId(current => (current === item.id ? null : current)));
    setSpeakingId(item.id);
  };

  const selectedProviderInfo = useMemo(() => models.providers.find(item => item.provider === selectedProvider), [models.providers, selectedProvider]);
  const currentSession = useMemo(() => sessions.find(item => item.id === sessionId) || null, [sessions, sessionId]);

  const loadModel = async id => {
    const selection = await api(`/api/sessions/${id}/model`);
    setSelectedProvider(selection.modelProvider);
    setSelectedModel(selection.modelName);
    return selection;
  };

  const loadSessionMessages = async (id, targetChannel) => {
    const nextMessages = await api(`/api/sessions/${id}/messages?channel=${encodeURIComponent(targetChannel || '默认')}`);
    setMessages(nextMessages);
    setChannel(targetChannel || '默认');
  };

  const load = async id => {
    setSessionId(id);
    const [nextChannels, personaRes, atmosphereRes, modeRes] = await Promise.all([
      api(`/api/sessions/${id}/channels`),
      api(`/api/sessions/${id}/persona`),
      api(`/api/sessions/${id}/atmosphere`),
      api(`/api/mode?sessionId=${encodeURIComponent(id)}`)
    ]);
    setChannels(asArray(nextChannels));
    setPersona(personaRes?.persona || '');
    setPersonaDraft(personaRes?.persona || '');
    setAtmosphere(atmosphereRes?.atmosphere || '');
    setMode(modeRes?.mode || 'companion');
    setCompanionIntent(modeRes?.companionIntent || 'listen');
    await loadModel(id);
    const list = asArray(nextChannels);
    const target = list.find(item => item.name === '默认') ? '默认' : (list[0]?.name || '默认');
    await loadSessionMessages(id, target);
  };

  const switchChannel = async name => { if (!sessionId || streaming) return; await loadSessionMessages(sessionId, name); };

  const addChannel = async () => {
    const name = String(window.prompt('新频道名称') || '').trim().slice(0, 60);
    if (!name) return;
    await switchChannel(name);
    setChannels(current => [...current.filter(item => item.name !== name), { name, count: 0 }]);
  };

  const savePersona = async () => {
    try {
      const saved = await api(`/api/sessions/${sessionId}/persona`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: personaDraft }) });
      setPersona(saved.persona); setError('');
    } catch (err) { setError(err.message); }
  };

  const saveAtmosphere = async presetId => {
    try {
      const saved = await api(`/api/sessions/${sessionId}/atmosphere`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ atmosphere: presetId }) });
      setAtmosphere(saved.atmosphere);
    } catch (err) { setError(err.message); }
  };

  const createAgent = async event => {
    event.preventDefault();
    if (!agentDraft.name.trim()) return;
    try {
      const agent = await api('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agentDraft) });
      setAgents(current => [...current, agent]);
      setAgentDraft({ name: '', persona: '', provider: '', model: '' });
    } catch (err) { setError(err.message); }
  };

  const removeAgent = async id => {
    try { await api(`/api/agents/${id}`, { method: 'DELETE' }); setAgents(current => current.filter(item => item.id !== id)); }
    catch (err) { setError(err.message); }
  };

  const updateCurrentGroup = async changes => {
    try {
      const updated = await api(`/api/sessions/${sessionId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setSessions(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (err) { setError(err.message); }
  };

  const inviteAgent = id => updateCurrentGroup({ agentIds: [...new Set([...(sessions.find(item => item.id === sessionId)?.agentIds || []), id])] });
  const removeGroupAgent = id => updateCurrentGroup({ agentIds: (sessions.find(item => item.id === sessionId)?.agentIds || []).filter(agentId => agentId !== id) });
  const saveAgent = async (id, changes) => {
    try {
      const updated = await api(`/api/agents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setAgents(current => current.map(item => item.id === id ? updated : item));
    } catch (err) { setError(err.message); }
  };

  const createGroupSession = async () => {
    if (!agents.length) { setError('请先在 Arcana 添加好友 Agent'); return; }
    try {
      const session = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '群聊', kind: 'group', agentIds: agents.map(item => item.id) }) });
      setSessions(current => [session, ...current]);
      await load(session.id);
      setPage('chat');
    } catch (err) { setError(err.message); }
  };

  const exportData = async () => {
    try {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cochpia-export.json';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { setError(err.message); }
  };

  const importData = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: payload.state || payload }) });
      await refresh();
      await load(sessionId);
      setError('');
    } catch (err) { setError(err.message || '导入失败'); }
    event.target.value = '';
  };

  const refresh = async () => {
    const [nextSessions, nextMemory, nextPersonality, nextEvidence, nextHistory, modelCatalog, nextPresets, nextAgents] = await Promise.all([
      api('/api/sessions'), api('/api/memory/overview'), api('/api/personality'), api('/api/growth/evidence'), api('/api/personality/history'), api('/api/models'), api('/api/psychology/presets'), api('/api/agents')
    ]);
    const safeSessions = asArray(nextSessions);
    setSessions(safeSessions);
    setMemory({ count: Number(nextMemory?.count) || 0, memories: asArray(nextMemory?.memories) });
    setPersonality(nextPersonality && typeof nextPersonality === 'object' ? nextPersonality : null);
    setGrowthEvidence(asArray(nextEvidence));
    setPersonalityHistory(asArray(nextHistory));
    setModels(modelCatalog && Array.isArray(modelCatalog.providers) ? modelCatalog : { defaultProvider: 'mock', providers: [] });
    setAtmospherePresets(asArray(nextPresets));
    setAgents(asArray(nextAgents));
    if (safeSessions.some(item => item.id === sessionId)) await loadModel(sessionId);
    return safeSessions;
  };

  // R-020 stage 4: `syncWorkspace` and its 30-second polling effect were
  // removed with the /api/sync endpoint. The poll re-serialised every session,
  // message and memory on the server every 30 seconds and then discarded the
  // payload -- nothing ever applied the returned changes to UI state. If
  // multi-device sync is wanted later, it needs a consumer, not just a poller.

  const startEditingMessage = message => {
    const original = messages.find(item => item.id === message.id) || message;
    setEditingMessageId(original.id);
    setEditingText(original.content);
    setError('');
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditingText('');
  };

  const saveMessageEdit = async messageId => {
    const content = editingText.trim();
    if (!content) return setError('消息内容不能为空');
    try {
      const updated = await api(`/api/sessions/${sessionId}/messages/${messageId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
      });
      setMessages(current => current.map(item => item.id === messageId ? updated : item));
      cancelEditingMessage();
    } catch (err) { setError(err.message); }
  };

  const removeMessage = async messageId => {
    if (!window.confirm('确定删除这条消息吗？')) return;
    try {
      await api(`/api/sessions/${sessionId}/messages/${messageId}`, { method: 'DELETE' });
      setMessages(current => current.filter(item => item.id !== messageId));
    } catch (err) { setError(err.message); }
  };

  const currentVersion = asArray(personalityHistory)[0];
  const previousVersion = asArray(personalityHistory)[1];
  const versionChanges = currentVersion && previousVersion
    ? currentVersion.traits.map(trait => ({ ...trait, previous: previousVersion.traits.find(item => item.key === trait.key)?.value ?? trait.value, delta: trait.value - (previousVersion.traits.find(item => item.key === trait.key)?.value ?? trait.value) }))
    : [];

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) { setUser(data.session?.user || null); setAuthReady(true); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!authReady || (supabase && !user)) return;
    refresh().then(async availableSessions => {
      if (availableSessions[0]?.id) await load(availableSessions[0].id);
      else await newSession();
    }).catch(err => setError(err.message));
  }, [authReady, user]);

  const modalOpen = settingsOpen || profileOpen || growthOpen || historyOpen || Boolean(pendingApproval);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      if (pendingApproval) respondApproval(false);
      setSettingsOpen(false);
      setProfileOpen(false);
      setGrowthOpen(false);
      setHistoryOpen(false);
    };
    document.body.classList.add('modal-open');
    window.addEventListener('keydown', closeOnEscape);
    return () => { document.body.classList.remove('modal-open'); window.removeEventListener('keydown', closeOnEscape); };
  }, [modalOpen, pendingApproval]);

  useEffect(() => {
    if (page !== 'home') return undefined;
    const cards = Array.from(document.querySelectorAll('.aube-mini'));
    const onKeyDown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.currentTarget.click();
    };
    cards.forEach(card => {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', onKeyDown);
    });
    return () => cards.forEach(card => {
      card.removeEventListener('keydown', onKeyDown);
      card.removeAttribute('role');
      card.removeAttribute('tabindex');
    });
  }, [page]);

  const scrollToBottom = behavior => {
    const el = conversationRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: behavior || 'auto' });
  };
  const onConversationScroll = () => {
    const el = conversationRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottomRef.current = near;
    setJumpToBottom(!near);
  };
  const displayMessages = useMemo(() => {
    const flat = [];
    messages.forEach(message => {
      if (message.role === 'assistant' && !('isStreaming' in message) && mode !== 'work') {
        const segments = splitSegments(message.content);
        if (segments.length > 1) {
          segments.forEach((seg, i) => flat.push({ ...message, key: `${message.id}:${i}`, content: seg, lastInGroup: i === segments.length - 1 }));
        } else {
          flat.push({ ...message, key: message.id, grouped: false, lastInGroup: true });
        }
      } else {
        flat.push({ ...message, key: message.id, grouped: false, lastInGroup: true });
      }
    });
    return flat;
  }, [messages, mode]);
  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayMessages;
    return displayMessages.filter(item => String(item.content || '').toLowerCase().includes(q));
  }, [displayMessages, searchQuery]);
  const groupedMessages = useMemo(() => {
    const result = [];
    let last = '';
    for (const item of filteredMessages) {
      const label = dateLabel(item.createdAt);
      if (label !== last) { result.push({ type: 'date', key: `d:${label}`, label }); last = label; }
      result.push(item);
    }
    return result;
  }, [filteredMessages]);
  useEffect(() => {
    if (nearBottomRef.current) {
      const el = conversationRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const saveSelection = async (provider, model) => {
    if (streaming) return;
    setError('');
    try {
      const saved = await api(`/api/sessions/${sessionId}/model`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model })
      });
      setSelectedProvider(saved.modelProvider);
      setSelectedModel(saved.modelName);
      setSessions(current => current.map(item => item.id === sessionId ? { ...item, modelProvider: saved.modelProvider, modelName: saved.modelName } : item));
    } catch (err) { setError(err.message); }
  };

  const selectProvider = event => {
    const nextProvider = models.providers.find(item => item.provider === event.target.value);
    if (!nextProvider) return;
    const nextModel = nextProvider.model || nextProvider.suggestedModels?.[0] || '';
    if (nextProvider.ready) saveSelection(nextProvider.provider, nextModel);
  };

  const selectModel = event => saveSelection(selectedProvider, event.target.value);

  const testProvider = async provider => {
    const model = provider.model || provider.suggestedModels?.[0] || '';
    setTests(current => ({ ...current, [provider.provider]: { state: 'testing' } }));
    try {
      const result = await api(`/api/models/${provider.provider}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model })
      });
      setTests(current => ({ ...current, [provider.provider]: { state: 'success', result } }));
    } catch (err) {
      setTests(current => ({ ...current, [provider.provider]: { state: 'error', code: err.code, message: describeModelError(err) } }));
    }
  };

  const newSession = async () => {
    // R-020 stage 3: a private session must name its agent. Memory scoping is
    // per-agent, so a session without one cannot resolve a caller identity.
    if (!agents.length) { setError('请先在 Arcana 添加好友 Agent'); setPage('arcana'); return; }
    try {
      const session = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: agents[0].id }) });
      setSessions(current => [session, ...current]);
      await load(session.id);
    } catch (err) { setError(err.message); }
  };

  const deleteSession = async (id, event) => {
    if (event) event.stopPropagation();
    if (!window.confirm('确定删除这个会话吗？聊天记录将一并删除，无法恢复。')) return;
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
      const remaining = sessions.filter(s => s.id !== id);
      setSessions(remaining);
      if (sessionId === id) {
        if (remaining[0]?.id) await load(remaining[0].id);
        else await newSession();
      }
    } catch (err) { setError(err.message); }
  };
  const createEvent = event => { event.preventDefault(); setNewEvent({ title: '', date: '', type: 'plan', note: '' }); setEventOpen(false); };
  const removeEvent = () => {};

  const traitLabels = useMemo(() => {
    const map = {};
    asArray(personality?.traits).forEach(trait => { map[trait.key] = trait.label || trait.key; });
    return map;
  }, [personality]);
  const traitLabel = key => traitLabels[key] || key;

  const reloadGrowthState = async () => {
    const [nextPersonality, nextEvidence, nextHistory] = await Promise.all([
      api('/api/personality'), api('/api/growth/evidence'), api('/api/personality/history')
    ]);
    setPersonality(nextPersonality && typeof nextPersonality === 'object' ? nextPersonality : null);
    setGrowthEvidence(asArray(nextEvidence));
    setPersonalityHistory(asArray(nextHistory));
  };

  const reviewEvidence = async (id, status) => {
    if (reviewingEvidence) return;
    setReviewingEvidence(id);
    setError('');
    try {
      await api(`/api/growth/evidence/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      await reloadGrowthState();
    } catch (err) { setError(err.message); }
    finally { setReviewingEvidence(null); }
  };

  const reviewAllEvidence = async status => {
    const draftIds = growthEvidence.filter(item => item.status === 'draft' || !item.status).map(item => item.id);
    if (!draftIds.length || reviewingEvidence) return;
    setReviewingEvidence('all');
    setError('');
    try {
      await api('/api/growth/evidence/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: draftIds, status }) });
      await reloadGrowthState();
    } catch (err) { setError(err.message); }
    finally { setReviewingEvidence(null); }
  };

  const sendMessage = async event => {
    event.preventDefault();
    if (!input.trim() || streaming) return;
    void playUiSound('click');
    setError('');
    setToolEvents([]);
    setPendingApproval(null);
    const text = input.trim();
    // R-020 stage 3: companion chat goes to /api/chat/turns and work mode to
    // /api/chat/work. The work route also owns mode switching, so a switch
    // command has to be routed there even while the session is still in
    // companion mode -- otherwise "切换到工作模式" would be answered as small
    // talk and the switch would never happen.
    const workRoute = isWorkRouteMessage({ mode, text });
    if (sessions.find(item => item.id === sessionId)?.kind === 'group') {
      setInput('');
      setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }]);
      setStreaming(true);
      try {
        const result = await api('/api/chat/group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, message: text, channel }) });
        setMessages(current => [...current, ...(result.messages || [])]);
      } catch (err) { setError(err.message); setInput(text); }
      finally { setStreaming(false); }
      return;
    }
    setInput('');
    // One idempotency key per send: a network retry of the same message
    // resolves to the same turn instead of producing a second reply.
    const sendKey = (globalThis.crypto?.randomUUID?.() || `send-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const firstId = 'streaming-0';
    streamStateRef.current = { currentId: firstId, buffer: '', pausing: false, timer: null, counter: 0 };
    // Fresh run: the stop button stays inert until the meta event names the run.
    streamRunRef.current = { runId: null, workMode: workRoute, controller: new AbortController(), cancelled: false };
    setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString() }, { id: firstId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true }]);
    nearBottomRef.current = true;
    scrollToBottom('auto');
    setStreaming(true);
    let completionUnlockTimer;
    const streamProcess = () => {
      const st = streamStateRef.current;
      if (st.pausing) return;
      // 工作模式：连续流式输出，不分段、不延迟（代码含大量换行，分段会被切碎）
      if (mode === 'work') {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer } : item));
        return;
      }
      const taken = takeSegment(st.buffer);
      if (taken && taken.segment) {
        st.buffer = taken.rest;
        const finalizeId = st.currentId;
        st.counter += 1;
        st.currentId = `streaming-${st.counter}`;
        setMessages(current => {
          const next = current.map(item => item.id === finalizeId ? { ...item, content: taken.segment, isStreaming: false } : item);
          next.push({ id: st.currentId, role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true });
          return next;
        });
        st.pausing = true;
        st.timer = setTimeout(() => { st.pausing = false; streamProcess(); }, 420 + Math.random() * 380);
      } else {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer } : item));
      }
    };
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const streamHeaders = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) };
      // R-020 stage 3: /api/chat/turns is the companion path and speaks SSE
      // (meta/text/done/error). /api/chat/work keeps the legacy work-mode
      // protocol (text/tool/tool_pending/tool_result/done). The rendering
      // below handles both because the event names overlap where it matters.
      const chatEndpoint = workRoute ? `${apiBase}/api/chat/work` : `${apiBase}/api/chat/turns`;
      const reattachEndpoint = runIdValue => workRoute
        ? `${apiBase}/api/chat/work/${encodeURIComponent(runIdValue)}`
        : `${apiBase}/api/chat/turns/${encodeURIComponent(runIdValue)}`;
      // The idempotency key makes a retried send resolve to the same turn
      // instead of producing a second reply (companion path).
      let response = await fetch(chatEndpoint, {
        method: 'POST', headers: { ...streamHeaders, ...(workRoute ? {} : { 'Idempotency-Key': sendKey }) },
        body: JSON.stringify({ sessionId, message: text, channel }),
        signal: streamRunRef.current.controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || payload?.error || '流式连接失败');
      }
      let buffer = '';
      let streamError = '';
      let streamFinished = false;
      let runId = '';
      let lastEventId = '';
      let reconnectAttempts = 0;
      let fullText = '';
      let assistantMessageId = '';
      let assistantPending = false;
      const scheduleComposerUnlock = () => {
        clearTimeout(completionUnlockTimer);
        completionUnlockTimer = setTimeout(() => setStreaming(false), 1200);
      };
      const consumeSse = chunk => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        parts.forEach(part => {
          const eventName = part.match(/^event:\s*(.+)$/m)?.[1];
          const eventId = part.match(/^id:\s*(.+)$/m)?.[1];
          const dataText = part.match(/^data:\s*(.+)$/ms)?.[1];
          if (!eventName || !dataText) return;
          if (eventId) lastEventId = eventId;
          const data = JSON.parse(dataText);
          // Record the run id as soon as the server names it, so the stop
          // button has something to cancel.
          if (eventName === 'meta' && data.runId) streamRunRef.current.runId = data.runId;
          if (eventName === 'meta') { runId = data.runId || runId; if (data.provider) setActualModel({ provider: data.provider, model: data.model }); }
          if (eventName === 'text') { fullText += data.delta; streamStateRef.current.buffer += data.delta; streamProcess(); scheduleComposerUnlock(); }
          if (eventName === 'error') {
            streamError = describeModelError({ code: data.code, message: data.message || '生成失败' });
            setError(streamError);
          }
          if (eventName === 'tool') { setToolEvents(current => [...current, { name: data.name, args: data.args, result: null }]); }
          if (eventName === 'tool_pending') { setPendingApproval({ runId: data.runId, toolCallId: data.toolCallId, name: data.name, args: data.args }); }
          if (eventName === 'tool_result') { setToolEvents(current => { const next = [...current]; for (let i = next.length - 1; i >= 0; i -= 1) { if (next[i].result === null && next[i].name === data.name) { next[i] = { ...next[i], result: data.result }; break; } } return next; }); }
          if (eventName === 'done') {
            streamFinished = true;
            if (data.mode) setMode(data.mode);
            if (data.messageId) assistantMessageId = data.messageId;
            // A 'pending' turn is not a failure: the raw event is durable and
            // the reply will resolve on a later turn, so it must not be
            // reported as an error to the user.
            if (data.status === 'pending') { assistantPending = true; }
            else if (data.ok === false && !streamError) streamError = '模型没有完成本次回复';
          }
        });
      };
      const readStream = async currentResponse => {
        if (!currentResponse.ok) {
          const payload = await currentResponse.json().catch(() => null);
          throw new Error(payload?.error?.message || payload?.error || '流式连接失败');
        }
        const reader = currentResponse.body.getReader();
        const decoder = new TextDecoder();
        while (true) { const { value, done } = await reader.read(); if (done) break; consumeSse(decoder.decode(value, { stream: true })); if (streamFinished) { await reader.cancel(); break; } }
      };
      while (!streamFinished) {
        await readStream(response);
        if (streamFinished || !runId || streamRunRef.current.cancelled || reconnectAttempts >= 3) break;
        reconnectAttempts += 1;
        await new Promise(resolve => setTimeout(resolve, 250 * reconnectAttempts));
        if (streamRunRef.current.cancelled) break;
        response = await fetch(reattachEndpoint(runId), { signal: streamRunRef.current.controller.signal, headers: { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}), ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) } });
      }
      // A cancelled run is a deliberate stop, not a dropped connection.
      if (!streamFinished && !streamError && !streamRunRef.current.cancelled) streamError = 'SSE 连接中断，且无法恢复';
      if (streamError) throw new Error(streamError);
      const st = streamStateRef.current;
      if (st.timer) clearTimeout(st.timer);
      if (streamRunRef.current.cancelled) {
        // Whatever the server committed is the truth; the local streaming
        // bubble is provisional and must not outlive the stop.
        setMessages(current => current.filter(item => !item.id.startsWith('streaming-')));
        setStreaming(false);
        await loadSessionMessages(sessionId, channel).catch(() => {});
        return;
      }
      if (st.buffer.trim()) {
        setMessages(current => current.map(item => item.id === st.currentId ? { ...item, content: st.buffer, isStreaming: false } : item));
      } else {
        setMessages(current => current.filter(item => item.id !== st.currentId));
      }
      // A pending turn produced no text yet; say so instead of showing the
      // user an empty bubble that looks like a dropped reply.
      if (assistantPending) setError('这条消息已记录，回复会在下一轮补上');
      setStreaming(false);
      await loadSessionMessages(sessionId, channel).catch(() => {});
      void refresh().catch(err => setError(err.message));
      if (autoReadRef.current && fullText.trim()) { setSpeakingId(assistantMessageId || null); speak(fullText.trim(), () => setSpeakingId(null)); }
    } catch (err) {
      const st = streamStateRef.current;
      if (st.timer) clearTimeout(st.timer);
      if (streamRunRef.current.cancelled) {
        // The stop button aborts the fetch, which surfaces here as an
        // AbortError. Reporting it would look like a failure the user caused
        // on purpose, so the stop path stays silent and syncs with the server.
        setMessages(current => current.filter(item => !item.id.startsWith('streaming-')));
        await loadSessionMessages(sessionId, channel).catch(() => {});
        return;
      }
      setError(err.message);
      setInput(text);
      setMessages(current => current.filter(item => !item.id.startsWith('streaming-')));
    } finally { clearTimeout(completionUnlockTimer); setStreaming(false); }
  };

  // Stop an in-flight reply. The server decides what happens to the turn: for
  // the companion path it aborts generation and commits nothing, so no partial
  // reply is ever persisted (pinned by turn-stream.test.js T5). Work-mode runs
  // cancel through their own route.
  const cancelGeneration = async () => {
    const run = streamRunRef.current;
    if (!streaming || run.cancelled) return;
    run.cancelled = true;
    const st = streamStateRef.current;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.pausing = false;
    try {
      if (run.workMode) {
        if (sessionId) await api('/api/chat/work/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
      } else if (run.runId) {
        const session = supabase ? (await supabase.auth.getSession()).data.session : null;
        await fetch(`${apiBase}/api/chat/turns/${encodeURIComponent(run.runId)}`, {
          method: 'DELETE',
          headers: { ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }
        });
      }
    } catch {
      // A failed cancel request must not block the local stop; the abort below
      // still ends the stream, and the reload below reconciles with the server.
    }
    run.controller.abort();
    setStreaming(false);
  };

  const submitAuth = async event => {
    event.preventDefault();
    if (!supabase || !authEmail || !authPassword || authBusy) return;
    setAuthBusy(true); setError(''); setAuthNotice('');
    try {
      const result = authAction === 'sign-up'
        ? await supabase.auth.signUp({ email: authEmail, password: authPassword })
        : await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      const { data, error: authError } = result;
      if (authError) {
        setError(authError.message);
      } else if (authAction === 'sign-up' && !data.session) {
        setAuthNotice('账户已创建。请查收邮箱中的确认链接，确认后再登录。');
        setAuthAction('sign-in');
        setAuthPassword('');
      } else {
        setUser(data.user);
      }
    } catch (authException) {
      setError(authException.message || '认证服务暂时不可用');
    } finally {
      setAuthBusy(false);
    }
  };

  const toggleWindow = id => {
    const windowRecord = windowState.windows[id];
    if (windowRecord && !windowRecord.closed && !windowRecord.minimized) {
      closeWindow(id);
      return;
    }
    restoreWindow(id);
    focusWindow(id);
  };
  const openSettings = () => toggleWindow('settings');
  const openMusic = () => toggleWindow('music');
  const fileRef = useRef(null);
  const uploadFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    setError('');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
      });
      const result = await api('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, dataUrl }) });
      setInput(current => `${current}${current ? '\n' : ''}[上传文件：${result.path}（${Math.round(result.size / 1024)}KB）]`);
    } catch (err) { setError(err.message); }
  };
  const respondApproval = async approved => {
    if (!pendingApproval) return;
    try {
      await api('/api/chat/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pendingApproval, approved }) });
    } catch (err) { setError(err.message); }
    setPendingApproval(null);
  };
  const toggleMode = async () => {
    const next = mode === 'companion' ? 'work' : 'companion';
    try {
      const result = await api('/api/mode', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: next, sessionId, companionIntent }) });
      setMode(result.mode);
      setCompanionIntent(result.companionIntent || 'listen');
    } catch (err) { setError(err.message); }
  };

  if (supabase && !authReady) return <main className="auth-shell"><p className="auth-loading">正在检查登录状态…</p></main>;
  if (supabase && authReady && !user) return <main className="auth-shell"><form className="auth-panel" onSubmit={submitAuth}><p className="eyebrow">COCHPIA AUTH</p><h1>进入你的共同空间</h1><label>邮箱<input type="email" value={authEmail} onChange={event => setAuthEmail(event.target.value)} autoComplete="email" required /></label><label>密码<input type="password" value={authPassword} onChange={event => setAuthPassword(event.target.value)} autoComplete={authAction === 'sign-in' ? 'current-password' : 'new-password'} required /></label><button className="auth-submit" disabled={authBusy}>{authBusy ? '处理中…' : authAction === 'sign-in' ? '登录' : '创建账户'}</button><button type="button" className="auth-switch" onClick={() => { setAuthAction(authAction === 'sign-in' ? 'sign-up' : 'sign-in'); setError(''); setAuthNotice(''); }}>{authAction === 'sign-in' ? '首次使用？创建账户' : '已有账户？返回登录'}</button>{authNotice && <p className="auth-notice" role="status">{authNotice}</p>}{error && <p className="auth-error" role="alert">{error}</p>}</form></main>;

  return <><BackgroundLayer /><GroupInfoPanel session={currentSession} agents={agents} open={groupPanelOpen} onClose={() => setGroupPanelOpen(current => !current)} onSave={updateCurrentGroup} onInvite={inviteAgent} onRemove={removeGroupAgent} onAgentSave={saveAgent} onAgentRemove={removeAgent} /><div className={`app-shell${minimized ? ' minimized' : ''}`}>
    <div className="workspace-clock-overlay">{workspaceClock}</div>
    {user && supabase && <button className="auth-logout" onClick={() => supabase.auth.signOut()}>退出</button>}
    {page !== 'splash' && <div className="aube-lights"><i className="l-red" aria-hidden="true" /><i className="l-yellow" aria-hidden="true" /><button type="button" className="l-green" onClick={() => setMinimized(true)} title="最小化" aria-label="最小化应用" /></div>}
    {page === 'splash' && <button type="button" className="aube-splash" onClick={() => setPage('home')} aria-label="进入 Cochpia"><video className="aube-splash-video" src="/306155_medium.mp4" autoPlay muted loop playsInline preload="auto" aria-hidden="true" /><span className="aube-splash-veil" aria-hidden="true" /><span className="aube-splash-center"><span className="aube-orb"><span className="aube-orb-core" /></span><span className="aube-word">Cochpia</span><span className="aube-tag">Still Blooming</span><span className="aube-divider"><i /><em>✦</em><i /></span><span className="aube-hint">轻触进入</span></span></button>}
    {page !== 'splash' && <nav className="aube-nav"><button className={`aube-nav-item ${page === 'home' ? 'active' : ''}`} onClick={() => setPage('home')}><span className="aube-nav-dot">⌂</span><span className="aube-nav-lbl">Sanctum</span></button><button className={`aube-nav-item ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')}><span className="aube-nav-dot">✎</span><span className="aube-nav-lbl">Chat</span></button><button className={`aube-nav-item ${page === 'arcana' ? 'active' : ''}`} onClick={() => setPage('arcana')}><span className="aube-nav-dot">⌗</span><span className="aube-nav-lbl">Arcana</span></button><button className="aube-nav-item" onClick={openMusic}><span className="aube-nav-dot">♫</span><span className="aube-nav-lbl">Music</span></button><button className="aube-nav-item" onClick={() => setWorkspaceSetting('theme', 'themeId', workspacePreferences.theme.themeId === 'sakura' ? 'ink' : 'sakura')}><span className="aube-nav-dot">◐</span><span className="aube-nav-lbl">Veil</span></button><button className="aube-nav-item" onClick={openSettings}><span className="aube-nav-dot">⚙</span><span className="aube-nav-lbl">设置</span></button></nav>}
    {page === 'home' && <div className="aube-page-overlay"><div className="aube-page-scroll"><div className="aube-card aube-profile"><div className="aube-pava">{profile.avatarImage ? <img src={profile.avatarImage} alt={profile.name} /> : profile.avatar}</div><div><div className="aube-pname">{profile.name}<button type="button" className="text-button profile-edit" onClick={() => setProfileOpen(true)}>编辑档案</button></div><div className="aube-pquote">{personality?.summary || '温和、好奇，正在学习如何更准确地陪伴。'}</div><div className="aube-tags">{(personality?.traits || []).slice(0, 4).map(trait => <span key={trait.key}>{trait.label} {Math.round(trait.value * 100)}%</span>)}</div></div></div><div className="aube-duo"><div className="aube-card aube-mini" onClick={newSession}><span className="aube-mi"><FeatherIcon name="plus" size={18} /></span><h5>新的相遇</h5><small>{sessions.length} 个会话</small></div><div className="aube-card aube-mini" onClick={() => setEventOpen(true)}><span className="aube-mi"><FeatherIcon name="calendar" size={18} /></span><h5>日历</h5><small>{events.length} 条日程</small></div></div><div className="aube-sec">Sessions</div><div className="aube-sessions">{sessions.map(session => <div key={session.id} className={`aube-session-row ${session.id === sessionId ? 'active' : ''}`}><button className="aube-session" onClick={() => { load(session.id); setPage('chat'); }}>{session.title}</button><button type="button" className="session-delete" onClick={event => deleteSession(session.id, event)} title="删除会话"><FeatherIcon name="x" size={16} /></button></div>)}</div><div className="aube-sec">Pulse</div><div className="aube-card aube-pulse">{(personality?.traits || []).map(trait => <div className="aube-prow" key={trait.key}><span className="aube-pl">{trait.label}</span><div className="aube-pbar"><i style={{ width: `${trait.value * 100}%` }} /></div><span className="aube-pv">{Math.round(trait.value * 100)}</span></div>)}</div></div></div>}
    {page === 'life' && <div className="aube-page-overlay"><div className="aube-page-scroll"><div className="aube-card" style={{ padding: '24px', lineHeight: 1.8 }}>共生模式正在重建。<br />记忆与生活状态会以 Agent 自己的节奏生长，这里将呈现它的日常。</div></div></div>}

    {page === 'arcana' && <div className="aube-page-overlay"><div className="aube-page-scroll"><div className="aube-ptitle">Arcana</div><div className="aube-sect">Persona · 人格</div><textarea className="persona-input" value={personaDraft} onChange={event => setPersonaDraft(event.target.value)} rows="4" placeholder="自定义本会话 Cochpia 的人格与语气,留空使用默认人格…" /><button className="select-model" style={{ marginTop: 10 }} onClick={savePersona}>保存人格</button><div className="aube-sect">Veil · 主题</div><div className="aube-veils">{[['sakura', '樱花'], ['ember', '余烬'], ['moss', '苔藓'], ['ink', '墨'], ['va11', '赛博']].map(([id, name]) => <button key={id} className={`aube-veil ${workspacePreferences.theme.themeId === id ? 'active' : ''}`} onClick={() => setWorkspaceSetting('theme', 'themeId', id)}>{name}</button>)}</div><div className="aube-sect">Atmosphere · 氛围</div><select value={atmosphere} onChange={event => saveAtmosphere(event.target.value)}><option value="">默认</option>{atmospherePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name} · {preset.description}</option>)}</select><div className="aube-sect">Model · 模型</div><select value={selectedProvider} onChange={selectProvider}><option value="">选择供应商</option>{models.providers.map(provider => <option key={provider.provider} value={provider.provider} disabled={!provider.ready}>{provider.label}{provider.ready ? '' : ' · 未配置'}</option>)}</select><select value={selectedModel} onChange={selectModel} style={{ marginTop: 8 }}><option value="">选择模型</option>{providerModelOptions(selectedProviderInfo).map(model => <option key={model} value={model}>{model}</option>)}</select><div className="aube-sect" style={{ marginTop: 16 }}>Providers</div>{models.providers.map(provider => <div className="aube-row" key={provider.provider}><span>{provider.label}</span><span className="aube-row-rv">{provider.ready ? '已配置' : '未配置'}</span></div>)}<div className="aube-sect">Agents · 好友</div>{agents.length === 0 ? <div className="aube-row"><span style={{ color: 'var(--text-muted)' }}>还没有好友 Agent,添加一个试试</span></div> : agents.map(agent => <div className="aube-row" key={agent.id}><span>{agent.avatar} {agent.name}</span><span className="aube-row-rv">{agent.provider ? `${agent.provider}/${agent.model || '默认'}` : '默认模型'}</span><button type="button" className="text-button" onClick={() => removeAgent(agent.id)}>删</button></div>)}<form className="agent-form" onSubmit={createAgent}><input value={agentDraft.name} onChange={event => setAgentDraft(current => ({ ...current, name: event.target.value }))} placeholder="名称" /><input value={agentDraft.persona} onChange={event => setAgentDraft(current => ({ ...current, persona: event.target.value }))} placeholder="人格(可选)" /><select value={agentDraft.provider} onChange={event => setAgentDraft(current => ({ ...current, provider: event.target.value }))}><option value="">默认模型</option>{models.providers.filter(provider => provider.ready).map(provider => <option key={provider.provider} value={provider.provider}>{provider.label}</option>)}</select><input value={agentDraft.model} onChange={event => setAgentDraft(current => ({ ...current, model: event.target.value }))} placeholder="模型名" /><AvatarPicker value={agentDraft.avatar} onChange={avatar => setAgentDraft(current => ({ ...current, avatar }))} /><button type="submit">添加</button></form><button className="select-model" style={{ marginTop: 10, width: '100%' }} onClick={createGroupSession}>创建群聊(含全部好友)</button><div className="aube-sect">共同空间 · Shared state</div><button type="button" className="select-model" style={{ width: '100%' }} onClick={() => restoreWindow('inspector')}><FeatherIcon name="eye" size={15} /> 查看共同状态</button><div className="aube-sect">Data · 数据</div><div className="aube-row"><button className="text-button" onClick={exportData}>导出数据</button><label className="text-button" style={{ marginLeft: 16, cursor: 'pointer' }}>导入数据<input type="file" accept="application/json,.json" onChange={importData} hidden /></label></div></div></div>}
    <div className="model-dock">
      <label htmlFor="model-provider">模型供应商</label>
      <select id="model-provider" value={selectedProvider} onChange={selectProvider} disabled={streaming}>
        {models.providers.map(item => <option key={item.provider} value={item.provider} disabled={!item.ready}>{item.label}{item.ready ? '' : ' · 未配置'}</option>)}
      </select>
      <select aria-label="选择模型" value={selectedModel} onChange={selectModel} disabled={streaming || !selectedProviderInfo?.ready}>
        {providerModelOptions(selectedProviderInfo).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
      <select aria-label="互动氛围" value={atmosphere} onChange={event => saveAtmosphere(event.target.value)} disabled={streaming}>
        <option value="">氛围</option>
        {atmospherePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
      <div className="model-dock-info"><strong>{selectedProviderInfo?.useCases || '等待模型目录加载'}</strong><span>{selectedProviderInfo?.ready ? '当前会话模型已保存' : '当前模型尚未配置'}</span>{actualModel.model && <small>实际：{actualModel.provider} / {actualModel.model}</small>}</div>
      <button className="icon-button compact" aria-label="Open music" title="Open music" onClick={openMusic}>♫</button><button className="icon-button compact" aria-label="打开设置" title="打开设置" onClick={openSettings}>⚙</button>
    </div>

    <aside className="sidebar"><div className="brand"><span className="brand-mark">{profile.avatarImage ? <img src={profile.avatarImage} alt={profile.name} /> : profile.avatar}</span><div><strong>{profile.name}</strong><span>relationship workspace</span></div></div><button className="new-chat" onClick={newSession}><span>+</span> 新的相遇</button><div className="section-label">会话</div><nav className="session-list">{sessions.map(session => <div key={session.id} className={`session-row ${session.id === sessionId ? 'active' : ''}`}><button className="session" onClick={() => load(session.id)}><span className="session-dot" />{session.title}</button><button type="button" className="session-delete" onClick={event => deleteSession(session.id, event)} title="删除会话"><FeatherIcon name="x" size={16} /></button></div>)}</nav><div className="sidebar-foot"><span className="status-dot" />本地开发模式<span className="version">v0.1</span><button type="button" className="text-button" onClick={exportData}>导出</button><label className="text-button import-label">导入<input type="file" accept="application/json,.json" onChange={importData} hidden /></label></div></aside>

    <main className={`main-panel ${page !== 'chat' ? 'is-page-hidden' : ''}`}><header className="topbar"><div><p className="eyebrow">LIVE RELATIONSHIP LOG</p><h1>与你共同成长的空间</h1></div><div className="top-actions"><button className="icon-button" aria-label="切换主题" title="切换主题" onClick={() => setWorkspaceSetting('theme', 'themeId', workspacePreferences.theme.themeId === 'sakura' ? 'ink' : 'sakura')}><FeatherIcon name={workspacePreferences.theme.themeId === 'sakura' ? 'moon' : 'sun'} size={16} /></button><span className="connection"><span className="status-dot" /> SSE 已连接</span></div></header><div className="channel-bar">{page === 'chat' && <div className="chat-context-tools"><button type="button" className="text-button" aria-label="模型设置" title="模型设置" onClick={() => setSettingsOpen(true)}>模型设置</button><GroupChatIdentity session={currentSession} agents={agents} onOpen={() => setGroupPanelOpen(true)} /></div>}<div className="channel-tabs">{channels.map(item => <button type="button" key={item.name} className={item.name === channel ? 'channel-tab active' : 'channel-tab'} onClick={() => switchChannel(item.name)}>{item.name}<span className="channel-count">{item.count}</span></button>)}<button type="button" className="channel-tab channel-add" aria-label="新建频道" title="新建频道" onClick={addChannel}><FeatherIcon name="plus" size={16} /></button></div><input className="chat-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索聊天记录" /><button type="button" className={`mode-toggle ${mode}`} onClick={toggleMode} title={mode === 'companion' ? '当前陪伴模式，点击切换工作模式' : '当前工作模式，点击切回陪伴模式'}>{mode === 'companion' ? '陪伴' : '工作'}</button></div><div className="conversation" ref={conversationRef} onScroll={onConversationScroll}>{messages.length === 0 && <div className="empty-state"><span className="empty-mark">01</span><h2>从一段真实的分享开始</h2><p>每次对话都会成为可审计的共同经历，只有重要的内容才会进入长记忆。</p></div>}{groupedMessages.map(item => item.type === 'date' ? <div key={item.key} className="date-sep"><span>{item.label}</span></div> : <article key={item.key} className={`message ${item.role}${item.grouped ? ' grouped' : ''}`}><div className="avatar">{item.role === 'assistant' ? (item.senderAvatar || (profile.avatarImage ? <img src={profile.avatarImage} alt="" /> : profile.avatar)) : '你'}</div><div className="message-content"><div className="message-meta">{item.role === 'assistant' ? (item.senderName || profile.name) : '你'}<time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div>{editingMessageId === item.id && item.lastInGroup ? <div className="message-edit"><textarea value={editingText} onChange={event => setEditingText(event.target.value)} autoFocus /><div><button type="button" className="text-button" onClick={() => saveMessageEdit(item.id)}>保存</button><button type="button" className="text-button muted-button" onClick={cancelEditingMessage}>取消</button></div></div> : <><div className="bubble">{item.content || <span className="typing">正在形成回应<span>.</span><span>.</span><span>.</span></span>}{item.isStreaming && item.content ? <span className="typing-cursor" /> : null}</div>{item.lastInGroup && !('isStreaming' in item) && <div className="message-actions">{item.role === 'assistant' && ttsSupported && <button type="button" className="text-button" onClick={() => toggleSpeak(item)}>{speakingId === item.id ? '停止朗读' : '朗读'}</button>}<button type="button" className="text-button" onClick={() => startEditingMessage(item)}>编辑</button><button type="button" className="text-button danger-button" onClick={() => removeMessage(item.id)}>删除</button></div>}</>}</div></article>)}{toolEvents.length > 0 && <div className="tool-log">{toolEvents.map((item, i) => <details key={i} className="tool-item" open={item.result === null}><summary>🔧 {item.name} {item.args?.path || item.args?.pattern || item.args?.name || item.args?.dir || ''}</summary>{item.result === null ? <span className="tool-pending">执行中…</span> : <pre className="tool-result">{item.result}</pre>}</details>)}</div>}{jumpToBottom && <button className="jump-bottom" onClick={() => { nearBottomRef.current = true; setJumpToBottom(false); scrollToBottom('smooth'); }} aria-label="回到底部" title="回到底部"><FeatherIcon name="chevronDown" size={18} /></button>}</div><form className="composer" onSubmit={sendMessage}><CompanionIntentBar mode={mode} intent={companionIntent} onChange={setCompanionIntent} /><button type="button" className="upload-button" onClick={() => fileRef.current?.click()} disabled={streaming} aria-label="上传文件" title="上传文件"><FeatherIcon name="paperclip" size={17} /></button><button type="button" className={`upload-button voice-button${listening ? ' listening' : ''}`} onClick={toggleListening} disabled={streaming || !recognitionSupported} aria-pressed={listening} aria-label={listening ? '停止语音输入' : '语音输入'} title={recognitionSupported ? (listening ? '点击停止说话' : '点击开始说话') : '当前浏览器不支持语音识别'}>{listening ? <FeatherIcon name="stopCircle" size={17} /> : <FeatherIcon name="mic" size={17} />}</button><button type="button" className={`upload-button auto-read${autoRead ? ' active' : ''}`} onClick={toggleAutoRead} disabled={!ttsSupported} aria-pressed={autoRead} aria-label="自动朗读回复" title={ttsSupported ? (autoRead ? '已开启自动朗读回复' : '开启自动朗读回复') : '当前浏览器不支持语音合成'}><FeatherIcon name="volume2" size={17} /></button><textarea value={listening ? `${input}${finalText}${interimText}` : input} onChange={event => setInput(event.target.value)} disabled={streaming} readOnly={listening} placeholder={listening ? '正在聆听…' : '写下此刻想分享的事…'} rows="1" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} /><input ref={fileRef} type="file" hidden onChange={uploadFile} />{streaming ? <button type="button" className="send-button stop-button" onClick={cancelGeneration} aria-label="停止生成" title="停止生成"><FeatherIcon name="stopCircle" size={18} /></button> : <button className="send-button" disabled={!input.trim()} aria-label="发送消息" title="发送消息"><FeatherIcon name="arrowUp" size={18} /></button>}<div className="composer-note">Enter 发送 · 🎤 语音输入 · 🔊 自动朗读</div></form></main>

    <div className="window-layer"><FloatingWindow id="inspector" title="共同状态"><aside className="inspector"><div className="inspector-head"><div><p className="eyebrow">COGNITIVE STATE</p><h2>共同状态</h2></div><span className="live-pill">LIVE</span></div><section className="state-card"><div className="state-card-top"><span className="state-icon">✦</span><div><strong>关系正在形成</strong><span>基于共同事件持续更新</span></div></div><div className="state-line"><span>共享记忆</span><strong>{memory.count}</strong></div><div className="state-line"><span>人格版本</span><strong>v{personality?.version || 1}</strong></div></section><MaterialPreview /><section className="inspector-section"><div className="section-heading"><span>人格趋势</span><button type="button" className="text-button" onClick={() => setHistoryOpen(true)}>查看版本</button></div>{(personality?.traits || []).map(trait => <div className="trait" key={trait.key}><div><span>{trait.label}</span><b>{Math.round(trait.value * 100)}%</b></div><div className="progress"><i style={{ width: `${trait.value * 100}%` }} /></div></div>)}</section><section className="inspector-section"><div className="section-heading"><span>最近记忆</span><span className="count-label">{memory.count} 条</span></div>{memory.memories.slice(0, 3).map(item => <div className="memory-item" key={item.id}><span className="memory-type">{item.type === 'relationship' ? '关系' : '事件'}</span><p>{item.summary}</p><small>{Math.round(item.confidence * 100)}% 确信 · {item.source}</small></div>)}</section><section className="inspector-section"><div className="section-heading"><span>成长证据</span><button type="button" className="text-button" onClick={() => setGrowthOpen(true)}>查看时间线</button></div>{growthEvidence.slice(0, 2).map(item => <div className="memory-item" key={item.id}><span className="memory-type">{item.status || 'draft'}</span><p>{item.claim}</p><small>{item.evidence}</small></div>)}</section><section className="protocol-note"><span>◎</span><p><strong>可验证成长</strong>每次人格变化都保留证据和版本，随时可回滚。</p></section></aside></FloatingWindow></div>

    {growthOpen && <GrowthPanel growthEvidence={growthEvidence} reviewingEvidence={reviewingEvidence} reviewAllEvidence={reviewAllEvidence} reviewEvidence={reviewEvidence} traitLabel={traitLabel} onClose={() => setGrowthOpen(false)} />}
    {historyOpen && <HistoryPanel currentVersion={currentVersion} previousVersion={previousVersion} versionChanges={versionChanges} traitLabel={traitLabel} onClose={() => setHistoryOpen(false)} />}
    {profileOpen && <ProfilePanel pendingApproval={pendingApproval} respondApproval={respondApproval} onClose={() => setProfileOpen(false)} />}
    {pendingApproval && <div className="settings-backdrop" role="presentation" onClick={() => respondApproval(false)}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title"><header className="settings-header"><div><p className="eyebrow">WORK MODE · 待确认修改</p><h2 id="approval-title">确认执行 {pendingApproval.name} 操作？</h2><p>该操作会修改文件，请确认内容无误。</p></div><button className="icon-button" onClick={() => respondApproval(false)}><FeatherIcon name="x" size={16} /></button></header><div className="approval-body"><div className="approval-path">📄 {String(pendingApproval.args?.path || '')}</div>{pendingApproval.name === 'edit' ? <div className="approval-diff"><div className="approval-old">− {String(pendingApproval.args?.oldText || '').slice(0, 500)}</div><div className="approval-new">+ {String(pendingApproval.args?.newText || '').slice(0, 500)}</div></div> : pendingApproval.name === 'bash' ? <pre className="approval-content">$ {String(pendingApproval.args?.command || '')}</pre> : <pre className="approval-content">{String(pendingApproval.args?.content || '').slice(0, 2000)}</pre>}<div className="approval-actions"><button type="button" className="select-model" onClick={() => respondApproval(true)}>确认执行</button><button type="button" className="text-button muted-button" onClick={() => respondApproval(false)}>拒绝</button></div></div></section></div>}
    {settingsOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="settings-header"><div><p className="eyebrow">MODEL DIRECTORY</p><h2 id="settings-title">模型设置</h2><p>查看适用场景并测试服务端连接。密钥不会进入浏览器。</p></div><button className="icon-button" aria-label="关闭模型设置" title="关闭模型设置" onClick={() => setSettingsOpen(false)}><FeatherIcon name="x" size={16} /></button></header><div className="persona-panel"><div className="section-heading"><span>人格 Persona</span><button type="button" className="text-button" onClick={savePersona}>保存人格</button></div><textarea className="persona-input" value={personaDraft} onChange={event => setPersonaDraft(event.target.value)} placeholder="自定义本会话 Cochpia 的人格与语气,留空使用默认人格…" rows="4" /><div className="persona-hint">只影响当前会话,长度不超过 2000 字。</div></div><div className="settings-list">{models.providers.map(provider => { const test = tests[provider.provider]; return <article className={`provider-row ${provider.provider === selectedProvider ? 'selected' : ''}`} key={provider.provider}><div className="provider-main"><div><strong>{provider.label}</strong><span className={`provider-status ${provider.ready ? 'ready' : 'unready'}`}>{provider.ready ? '已配置' : '未配置'}</span></div><p>{provider.useCases}</p><small>{provider.protocol} · 建议：{provider.suggestedModels.join(' / ')}</small>{test?.state === 'success' && <small className="test-success">连接成功 · {test.result.latencyMs}ms</small>}{test?.state === 'error' && <small className="test-error">{test.message}</small>}</div><div className="provider-actions"><button className="text-button" disabled={!provider.ready || test?.state === 'testing'} onClick={() => testProvider(provider)}>{test?.state === 'testing' ? '测试中…' : '测试连接'}</button><button className="select-model" disabled={!provider.ready} onClick={() => { saveSelection(provider.provider, provider.model || provider.suggestedModels[0]); setSettingsOpen(false); }}>{provider.provider === selectedProvider ? '当前会话' : '用于本会话'}</button></div></article>; })}</div></section></div>}
    
    {eventOpen && <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setEventOpen(false); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="event-title"><header className="settings-header"><div><p className="eyebrow">CALENDAR · 日历</p><h2 id="event-title">纪念日与计划</h2><p>临近的事项会自动注入对话上下文。</p></div><button className="icon-button" aria-label="关闭日历" title="关闭日历" onClick={() => setEventOpen(false)}><FeatherIcon name="x" size={16} /></button></header><form className="event-form" onSubmit={createEvent}><input value={newEvent.title} onChange={event => setNewEvent(current => ({ ...current, title: event.target.value }))} placeholder="标题,例如:初次相遇" aria-label="事件标题" /><input type="date" value={newEvent.date} onChange={event => setNewEvent(current => ({ ...current, date: event.target.value }))} aria-label="日期" /><select value={newEvent.type} onChange={event => setNewEvent(current => ({ ...current, type: event.target.value }))} aria-label="类型"><option value="anniversary">纪念日</option><option value="birthday">生日</option><option value="plan">计划</option><option value="record">记录</option></select><button className="select-model" type="submit" disabled={!newEvent.title.trim() || !newEvent.date}>添加</button></form><div className="task-list">{events.length === 0 ? <p className="empty-detail">还没有日程。</p> : events.map(item => <div className="task-row" key={item.id}><div><strong>{item.title}</strong><small>{item.type === 'anniversary' ? '纪念日' : item.type === 'birthday' ? '生日' : item.type === 'plan' ? '计划' : '记录'} · {new Date(item.date).toLocaleDateString('zh-CN')}{item.note ? ' · ' + item.note : ''}</small></div><button type="button" className="t-del" title="删除" onClick={() => removeEvent(item.id)}><FeatherIcon name="x" size={16} /></button></div>)}</div></section></div>}
    <MusicWindow /><SettingsWindow />
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
  </div>{minimized && <button className="aube-minimize-btn" onClick={() => setMinimized(false)} title="展开 Cochpia">C</button>}</>;
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) { console.error('Cochpia UI runtime error', error); }

  render() {
    if (this.state.error) return <main className="auth-shell"><section className="auth-panel"><p className="eyebrow">COCHPIA UI ERROR</p><h1>页面暂时无法加载</h1><p className="auth-error">{this.state.error.message}</p><button className="auth-submit" onClick={() => window.location.reload()}>重新加载</button></section></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><WorkspacePreferencesProvider><I18nProvider><TimeProvider><MusicProvider><AudioProvider><VoiceProvider><MaterialProvider><WindowManagerProvider><ProfileProvider><App /></ProfileProvider></WindowManagerProvider></MaterialProvider></VoiceProvider></AudioProvider></MusicProvider></TimeProvider></I18nProvider></WorkspacePreferencesProvider></AppErrorBoundary>);

// PWA：生产环境注册 Service Worker；开发地址主动注销历史 SW，避免旧缓存接管页面。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    if (!import.meta.env.PROD) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
      }
      // 旧 SW 可能已经控制了本次页面；清缓存后只 reload 一次，确保旧 JS/CSS 不再运行。
      if (navigator.serviceWorker.controller && !sessionStorage.getItem('cochpia-sw-cleaned')) {
        sessionStorage.setItem('cochpia-sw-cleaned', '1');
        window.location.reload();
      }
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js?v=20260822-cache-fix-2', { updateViaCache: 'none' });
      await registration.update();
    } catch {
      /* SW 注册失败不影响主流程 */
    }
  });
}
