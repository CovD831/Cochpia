import React from 'react';
import FeatherIcon from '../icons/FeatherIcon';
import { agentInitial } from '../lib/utils';
import { CompanionIntentBar } from './panels';

// 聊天主面板（Chat）：顶部头部 / 频道栏 / 消息区 / 底部输入栏。
// 从 main.jsx 拆出，避免主界面 JSX 整块误删；所有状态与事件由 App 通过 props 注入。
export default function ChatPanel({
  page,
  currentSession,
  currentAgent,
  workspacePreferences,
  setWorkspaceSetting,
  channels,
  channel,
  switchChannel,
  addChannel,
  searchQuery,
  setSearchQuery,
  mode,
  toggleMode,
  toggleGroupMode,
  setGroupPanelOpen,
  conversationRef,
  onConversationScroll,
  messages,
  groupedMessages,
  profile,
  formatTime,
  editingMessageId,
  editingText,
  setEditingText,
  saveMessageEdit,
  cancelEditingMessage,
  startEditingMessage,
  removeMessage,
  toggleSpeak,
  speakingId,
  ttsSupported,
  dispatchedTasks,
  toolEvents,
  jumpToBottom,
  nearBottomRef,
  setJumpToBottom,
  scrollToBottom,
  companionIntent,
  setCompanionIntent,
  fileRef,
  uploadFile,
  streaming,
  listening,
  finalText,
  interimText,
  input,
  setInput,
  toggleListening,
  recognitionSupported,
  autoRead,
  toggleAutoRead,
  sendMessage
}) {
  if (!currentSession) return <main className={`main-panel ${page !== 'chat' ? 'is-page-hidden' : ''}`}><div className="empty-state chat-session-empty"><span className="empty-mark">✦</span><h2>{'还没有角色。去创建一个吧。'}</h2><button type="button" className="select-model" onClick={() => window.dispatchEvent(new Event('cochpia:create-agent'))}>新建角色</button></div></main>;
  const isGroup = currentSession?.kind === 'group';
  const themeId = workspacePreferences.theme.themeId;
  return (
    <main className={`main-panel ${page !== 'chat' ? 'is-page-hidden' : ''}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">{isGroup ? 'GROUP SPACE' : currentAgent ? 'PRIVATE CHAT' : 'LIVE RELATIONSHIP LOG'}</p>
          <h1>{isGroup ? (currentSession.title || '群聊') : currentAgent ? `${agentInitial(currentAgent)} ${currentAgent.remark || currentAgent.name}` : '与你共同成长的空间'}</h1>
          {currentAgent && <p className="topbar-sub">{currentAgent.signature || currentAgent.role || '私聊'}{currentAgent.remark ? ` · ${currentAgent.name}` : ''}</p>}
        </div>
        <div className="top-actions">
          <button className="icon-button" aria-label="切换主题" title="切换主题" onClick={() => setWorkspaceSetting('theme', 'themeId', themeId === 'sakura' ? 'ink' : 'sakura')}><FeatherIcon name={themeId === 'sakura' ? 'moon' : 'sun'} size={16} /></button>
          <span className="connection"><span className="status-dot" /> SSE 已连接</span>
        </div>
      </header>

      <div className="channel-bar">
        <div className="channel-tabs">
          {channels.map(item => <button type="button" key={item.name} className={item.name === channel ? 'channel-tab active' : 'channel-tab'} onClick={() => switchChannel(item.name)}>{item.name}<span className="channel-count">{item.count}</span></button>)}
          <button type="button" className="channel-tab channel-add" aria-label="新建频道" title="新建频道" onClick={addChannel}><FeatherIcon name="plus" size={16} /></button>
        </div>
        <input className="chat-search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索聊天记录" />
        <button type="button" className={`mode-toggle ${mode}`} onClick={toggleMode} title={mode === 'companion' ? '当前陪伴模式，点击切换工作模式' : '当前工作模式，点击切回陪伴模式'}>{mode === 'companion' ? '陪伴' : '工作'}</button>
        {isGroup && <>
          <button type="button" className="group-info-btn" onClick={toggleGroupMode} title={currentSession?.groupMode === 'turn' ? '当前轮流发言，点击切换并行' : '当前并行发言，点击切换轮流'}>{currentSession?.groupMode === 'turn' ? '轮流' : '并行'}</button>
          <button type="button" className="group-info-btn" onClick={() => setGroupPanelOpen(true)} title="群聊信息">群信息</button>
        </>}
      </div>

      <div className="conversation" ref={conversationRef} onScroll={onConversationScroll}>
        {messages.length === 0 && <div className="empty-state"><span className="empty-mark">01</span><h2>从一段真实的分享开始</h2><p>每次对话都会成为可审计的共同经历，只有重要的内容才会进入长记忆。</p></div>}
        {groupedMessages.map(item => item.type === 'date' ? <div key={item.key} className="date-sep"><span>{item.label}</span></div> : (
          <article key={item.key} className={`message ${item.role}${item.grouped ? ' grouped' : ''}`}>
            <div className="avatar">{item.role === 'assistant' ? (item.senderAvatar || '助') : '你'}</div>
            <div className="message-content">
              <div className="message-meta">{item.role === 'assistant' ? (item.senderName || '助手') : '你'}<time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div>
              {editingMessageId === item.id && item.lastInGroup ? (
                <div className="message-edit">
                  <textarea value={editingText} onChange={event => setEditingText(event.target.value)} autoFocus />
                  <div><button type="button" className="text-button" onClick={() => saveMessageEdit(item.id)}>保存</button><button type="button" className="text-button muted-button" onClick={cancelEditingMessage}>取消</button></div>
                </div>
              ) : (
                <>
                  <div className="bubble">{item.content || <span className="typing">正在形成回应<span>.</span><span>.</span><span>.</span></span>}{item.isStreaming && item.content ? <span className="typing-cursor" /> : null}</div>
                  {item.lastInGroup && !('isStreaming' in item) && (
                    <div className="message-actions">
                      {item.role === 'assistant' && ttsSupported && <button type="button" className="text-button" onClick={() => toggleSpeak(item)}>{speakingId === item.id ? '停止朗读' : '朗读'}</button>}
                      <button type="button" className="text-button" onClick={() => startEditingMessage(item)}>编辑</button>
                      <button type="button" className="text-button danger-button" onClick={() => removeMessage(item.id)}>删除</button>
                    </div>
                  )}
                </>
              )}
            </div>
          </article>
        ))}
        {dispatchedTasks.length > 0 && <div className="dispatched-tasks">{dispatchedTasks.map(item => <div className="dispatched-task" key={item.taskId}><span className="dispatched-task-icon">🚀</span><div className="dispatched-task-body"><strong>已派发给 {item.target}</strong><p>{item.task}</p><small>状态：{item.status}{item.message ? ` · ${item.message}` : ''} · 可在工作区查看进度</small></div></div>)}</div>}
        {toolEvents.length > 0 && <div className="tool-log">{toolEvents.map((item, i) => <details key={i} className="tool-item" open={item.result === null}><summary>🔧 {item.name} {item.args?.path || item.args?.pattern || item.args?.name || item.args?.dir || ''}</summary>{item.result === null ? <span className="tool-pending">执行中…</span> : <pre className="tool-result">{item.result}</pre>}</details>)}</div>}
        {jumpToBottom && <button className="jump-bottom" onClick={() => { nearBottomRef.current = true; setJumpToBottom(false); scrollToBottom('smooth'); }} aria-label="回到底部" title="回到底部"><FeatherIcon name="chevronDown" size={18} /></button>}
      </div>

      <form className="composer" onSubmit={sendMessage}>
        <CompanionIntentBar mode={mode} intent={companionIntent} onChange={setCompanionIntent} />
        <button type="button" className="upload-button" onClick={() => fileRef.current?.click()} disabled={streaming} aria-label="上传文件" title="上传文件"><FeatherIcon name="paperclip" size={17} /></button>
        <button type="button" className={`upload-button voice-button${listening ? ' listening' : ''}`} onClick={toggleListening} disabled={streaming || !recognitionSupported} aria-pressed={listening} aria-label={listening ? '停止语音输入' : '语音输入'} title={recognitionSupported ? (listening ? '点击停止说话' : '点击开始说话') : '当前浏览器不支持语音识别'}>{listening ? <FeatherIcon name="stopCircle" size={17} /> : <FeatherIcon name="mic" size={17} />}</button>
        <button type="button" className={`upload-button auto-read${autoRead ? ' active' : ''}`} onClick={toggleAutoRead} disabled={!ttsSupported} aria-pressed={autoRead} aria-label="自动朗读回复" title={ttsSupported ? (autoRead ? '已开启自动朗读回复' : '开启自动朗读回复') : '当前浏览器不支持语音合成'}><FeatherIcon name="volume2" size={17} /></button>
        <textarea value={listening ? `${input}${finalText}${interimText}` : input} onChange={event => setInput(event.target.value)} disabled={streaming} readOnly={listening} placeholder={listening ? '正在聆听…' : '写下此刻想分享的事…'} rows="1" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(event); } }} />
        <input ref={fileRef} type="file" hidden onChange={uploadFile} />
        <button className="send-button" disabled={streaming || !input.trim()} aria-label="发送消息" title="发送消息"><FeatherIcon name="arrowUp" size={18} /></button>
        <div className="composer-note">Enter 发送 · 🎤 语音输入 · 🔊 自动朗读</div>
      </form>
    </main>
  );
}
