import { useEffect, useMemo, useRef, useState } from 'react';
import FeatherIcon from '../icons/FeatherIcon';
import { api } from '../api';

const providerModelOptions = provider => provider ? [...new Set([...(provider.model ? [provider.model] : []), ...(provider.suggestedModels || [])])] : [];

const defaultIntegrations = {
  github: { repo: 'https://github.com/ksys404/Cochpia', branch: 'main', endpoint: '', connected: true },
  codex: { repo: '', branch: 'main', endpoint: '', connected: false },
  pi: { repo: '', branch: 'main', endpoint: '', connected: false },
  claude: { repo: '', branch: 'main', endpoint: '', connected: false },
  mcp: { repo: '', branch: 'main', endpoint: '', connected: false }
};

const integrationMeta = {
  github: { label: 'GitHub', eyebrow: 'SOURCE CONTROL', icon: 'fileText', description: '查看仓库、分支与提交，直接进入 GitHub。', accent: 'violet' },
  codex: { label: 'Codex', eyebrow: 'TASK ORCHESTRATOR', icon: 'grid', description: '把经过确认的开发任务交给 Codex 执行。', accent: 'blue' },
  pi: { label: 'Pi Agent', eyebrow: 'IMPLEMENTATION AGENT', icon: 'layers', description: '将具体开发、测试和修复任务交给 Pi。', accent: 'rose' },
  claude: { label: 'Claude Code', eyebrow: 'REVIEW AGENT', icon: 'messageSquare', description: '将审查、重构和验证任务交给 Claude Code。', accent: 'gold' },
  mcp: { label: 'MCP', eyebrow: 'TOOL CONNECTIONS', icon: 'users', description: '集中管理外部工具与 MCP 服务连接。', accent: 'gold' }
};

const workflowTemplate = [
  { id: 'analyze', label: '分析需求', detail: '整理目标、范围和验收条件。' },
  { id: 'prepare', label: '准备任务', detail: '绑定仓库、分支和执行端。' },
  { id: 'dispatch', label: '派发任务', detail: '将任务发送到已配置的 Agent 接口。' },
  { id: 'verify', label: '等待验证', detail: '等待 Agent 返回测试结果和变更摘要。' }
];

const workflowStatusLabels = {
  running: '执行中', paused: '已暂停', waiting: '等待返回', verifying: '验证中', reviewing: '待审查',
  completed: '已完成', failed: '失败', cancelled: '已停止'
};

const taskStatusMessages = {
  submitted: '服务端已接受任务，等待调度。',
  running: '执行器正在处理任务。',
  verifying: '执行器已返回，等待开始验证。',
  reviewing: '验证已通过，等待人工审查。',
  completed: '执行、验证和审查已通过。',
  failed: '任务执行失败，请展开详情查看日志。',
  cancelled: '任务已由服务端取消。'
};

const logText = entry => typeof entry === 'string' ? entry : entry?.text || entry?.reason || entry?.summary || entry?.type || '';
const stepsForStatus = (status, steps) => steps.map((step, index) => {
  if (status === 'completed') return { ...step, status: 'done' };
  if (status === 'verifying') return { ...step, status: index < 3 ? 'done' : 'active' };
  if (status === 'reviewing') return { ...step, status: 'done' };
  if (status === 'failed' || status === 'cancelled') return { ...step, status: index < 2 ? 'done' : index === 2 ? 'error' : 'pending' };
  return { ...step, status: index < 2 ? 'done' : index === 2 ? 'active' : 'pending' };
});

const collaborationRunToView = payload => ({
  kind: 'collaboration', id: payload.id, title: payload.spec?.name || '协作开发', target: 'pi → codex → 验证 → 审查',
  status: payload.status, startedAt: payload.createdAt, message: payload.goal,
  steps: (payload.stages || []).map(stage => ({
    id: stage.id, label: stage.id, detail: stage.role || '',
    status: stage.status === 'completed' ? 'done' : stage.status === 'failed' ? 'error' : ['running', 'verifying', 'reviewing'].includes(stage.status) ? 'active' : 'pending'
  })),
  logs: (payload.tasks || []).slice(-12).map(task => `${task.stageId || task.role || task.target}：${task.message || task.status}`)
});

function loadIntegrations() {
  return defaultIntegrations;
}

function StatusPill({ connected }) {
  return <span className={`workbench-status ${connected ? 'connected' : 'idle'}`}><i />{connected ? '已连接' : '未连接'}</span>;
}

function IntegrationCard({ id, selected, value, onSelect }) {
  const meta = integrationMeta[id];
  return <button type="button" className={`workbench-card ${meta.accent} ${selected ? 'selected' : ''}`} onClick={() => onSelect(id)} aria-pressed={selected}>
    <span className="workbench-card-icon"><FeatherIcon name={meta.icon} size={21} /></span>
    <span className="workbench-card-copy"><span className="workbench-eyebrow">{meta.eyebrow}</span><strong>{meta.label}</strong><span>{meta.description}</span></span>
    <StatusPill connected={value.connected} />
    <FeatherIcon name="chevronDown" size={17} className="workbench-card-arrow" />
  </button>;
}

function WorkflowPanel({ run, expanded, onToggle, onPause, onStop, onVerify, onReview, onGate, onSandboxAction }) {
  if (!run) return null;
  return <section className={`workflow-panel ${run.status}`} aria-labelledby="workflow-title">
    <div className="workflow-head">
      <div className="workflow-title-wrap"><span className="workflow-kicker">TASK FLOW</span><h3 id="workflow-title">{run.title}</h3><span className="workflow-subtitle">{workflowStatusLabels[run.status] || run.status} · {run.target}</span></div>
      <div className="workflow-actions">
        {run.status === 'verifying' && <button type="button" className="workbench-primary icon-action" onClick={onVerify} title="开始验证" aria-label="开始验证"><FeatherIcon name="check" size={15} /></button>}
        {run.status === 'waiting_approval' && <><button type="button" className="workbench-primary icon-action" onClick={() => onGate('allow')} title="允许继续" aria-label="允许继续"><FeatherIcon name="check" size={15} /></button><button type="button" className="workbench-secondary icon-action" onClick={() => onGate('interrupt')} title="补充意见并重试" aria-label="补充意见并重试"><FeatherIcon name="rotateCcw" size={15} /></button><button type="button" className="workbench-secondary icon-action" onClick={() => onGate('deny')} title="拒绝执行" aria-label="拒绝执行"><FeatherIcon name="x" size={15} /></button></>}
        {run.status === 'reviewing' && <><button type="button" className="workbench-primary icon-action" onClick={() => onReview('approve')} title="通过审查" aria-label="通过审查"><FeatherIcon name="check" size={15} /></button><button type="button" className="workbench-secondary icon-action" onClick={() => onReview('request_changes')} title="打回重验" aria-label="打回重验"><FeatherIcon name="rotateCcw" size={15} /></button><button type="button" className="workbench-secondary icon-action" onClick={() => onReview('reject')} title="拒绝任务" aria-label="拒绝任务"><FeatherIcon name="x" size={15} /></button></>}
        {run.status === 'completed' && run.sandboxPath && <><button type="button" className="workbench-primary icon-action" onClick={() => onSandboxAction('merge')} title="导出补丁" aria-label="导出补丁"><FeatherIcon name="download" size={15} /></button><button type="button" className="workbench-secondary icon-action" onClick={() => onSandboxAction('discard')} title="丢弃隔离目录" aria-label="丢弃隔离目录"><FeatherIcon name="trash2" size={15} /></button></>}
        {(run.status === 'running' || run.status === 'paused' || run.status === 'waiting') && <button type="button" className="workbench-secondary icon-action" onClick={onStop} title="停止任务" aria-label="停止任务"><FeatherIcon name="stopCircle" size={15} /></button>}
        <button type="button" className="workbench-secondary icon-action" onClick={onToggle} title={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded} aria-label={expanded ? '收起任务详情' : '展开任务详情'}><FeatherIcon name={expanded ? 'chevronUp' : 'chevronDown'} size={15} /></button>
      </div>
    </div>
    <div className="workflow-progress" aria-label="任务进度">{run.steps.map(step => <div className={`workflow-step ${step.status}`} key={step.id}><span className="workflow-step-mark">{step.status === 'done' ? <FeatherIcon name="check" size={13} /> : step.status === 'error' ? <FeatherIcon name="x" size={13} /> : step.status === 'active' ? <span className="workflow-step-dot" /> : <span />}</span><span>{step.label}</span></div>)}</div>
    {expanded && <div className="workflow-detail"><div className="workflow-log-head"><span>任务摘要</span><time>{new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>{run.message}</p><div className="workflow-log">{run.logs.map((entry, index) => <div key={`${logText(entry)}-${index}`}><span className="workflow-log-dot" />{logText(entry)}</div>)}</div></div>}
  </section>;
}

export default function WorkbenchPage({ models, selectedProvider, selectedModel, selectedProviderInfo, onSelectProvider, onSelectModel, onTestProvider, tests, onSaveSelection }) {
  const [integrations, setIntegrations] = useState(loadIntegrations);
  const [selected, setSelected] = useState('github');
  const [task, setTask] = useState('');
  const [notice, setNotice] = useState(null);
  const [run, setRun] = useState(null);
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const verificationRequestedRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api('/api/workbench/agents').then(({ agents }) => {
      if (cancelled) return;
      setIntegrations(current => Object.fromEntries(Object.keys(current).map(key => [key, { ...current[key], connected: Boolean(agents.find(agent => agent.id === key)?.available) }])));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!run?.id || ['completed', 'failed', 'cancelled'].includes(run.status)) return undefined;
    const timer = setInterval(() => {
      const request = run.kind === 'collaboration'
        ? api(`/api/workflows/runs/${run.id}`).then(payload => collaborationRunToView(payload))
        : api(`/api/workbench/tasks/${run.id}`).then(({ task: latest }) => ({ ...latest, kind: 'task' }));
      request.then(latest => {
        if (latest.kind === 'collaboration') setRun(current => current?.id === latest.id ? latest : current);
        else setRun(current => current?.id === latest.id ? { ...current, status: latest.status, message: latest.message || taskStatusMessages[latest.status] || current.message, sandboxPath: latest.sandboxPath, steps: stepsForStatus(latest.status, current.steps), logs: (latest.events || []).slice(-12).map(event => event.reason || event.summary || event.type) } : current);
      }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);

  const current = integrations[selected];
  const meta = integrationMeta[selected];
  const connectedCount = useMemo(() => Object.values(integrations).filter(item => item.connected).length, [integrations]);

  const updateCurrent = patch => setIntegrations(state => ({ ...state, [selected]: { ...state[selected], ...patch } }));
  const openGithub = () => window.open(current.repo || 'https://github.com', '_blank', 'noopener,noreferrer');

  const testConnection = async () => {
    if (selected === 'github') {
      if (!current.repo) return setNotice({ type: 'error', text: '请先填写 GitHub 仓库地址。' });
      updateCurrent({ connected: true });
      return setNotice({ type: 'success', text: 'GitHub 仓库地址已保存，可以直接打开。' });
    }
    try {
      const { agents } = await api('/api/workbench/agents');
      const agent = agents.find(item => item.id === selected);
      updateCurrent({ connected: Boolean(agent?.available) });
      setNotice({ type: agent?.available ? 'success' : 'error', text: agent?.available ? `${meta.label} 已由服务端接入。` : `${meta.label} 当前不可用。` });
    } catch (error) { setNotice({ type: 'error', text: `${meta.label} 状态检查失败：${error.message}` }); }
  };

  const deployTask = async () => {
    if (!task.trim()) return setNotice({ type: 'error', text: '先写下要部署的任务。' });
    if (selected === 'mcp') return setNotice({ type: 'error', text: 'MCP 服务注册尚未开放任务派发。' });
    if (!current.connected) return setNotice({ type: 'error', text: `${meta.label} 当前未启用，暂不能派发任务。` });
    const clientRunId = `${Date.now()}`;
    setRun({ id: null, clientRunId, title: task.trim(), target: meta.label, status: 'running', startedAt: new Date().toISOString(), message: '任务正在整理并发送，接口返回前不会占用聊天区域。', steps: workflowTemplate.map((step, index) => ({ ...step, status: index === 0 ? 'active' : 'pending' })), logs: ['已创建任务流', `目标执行端：${meta.label}`, `仓库：${integrations.github.repo || '未指定'}`, `分支：${integrations.github.branch || 'main'}`] });
    setWorkflowExpanded(false);
    try {
      const { task: payload } = await api('/api/workbench/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: selected, task: task.trim(), repository: integrations.github.repo, branch: integrations.github.branch, spec: { goal: task.trim(), acceptance: ['执行器返回结果', '测试通过', '构建通过', '审查结论通过'], excludes: ['解锁 Claude'] } }) });
      const status = payload?.status || 'submitted';
      setRun(currentRun => currentRun?.clientRunId !== clientRunId || currentRun.status === 'cancelled' ? currentRun : { ...currentRun, id: payload.id, status, sandboxPath: payload.sandboxPath, message: taskStatusMessages[status] || '服务端已接受任务。', steps: stepsForStatus(status, currentRun.steps), logs: [...currentRun.logs, '服务端已接受任务', `任务 ID：${payload.id}`] });
      setNotice({ type: 'success', text: status === 'completed' ? `任务已由 ${meta.label} 完成。` : `任务已发送到 ${meta.label}，${taskStatusMessages[status] || '正在执行。'}` });
      setTask('');
    } catch (error) {
      setRun(currentRun => currentRun?.clientRunId !== clientRunId || currentRun.status === 'cancelled' ? currentRun : { ...currentRun, status: 'failed', message: `派发失败：${error.message}`, steps: stepsForStatus('failed', currentRun.steps), logs: [...currentRun.logs, `请求失败：${error.message}`] });
      setNotice({ type: 'error', text: `任务发送失败：${error.message}` });
    }
  };

  const startCollaboration = async () => {
    if (!task.trim()) return setNotice({ type: 'error', text: '先写下协作开发目标。' });
    const goal = task.trim();
    try {
      const payload = await api('/api/workflows/collab-dev/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal }) });
      setRun(collaborationRunToView(payload));
      setWorkflowExpanded(false);
      setTask('');
      setNotice({ type: 'success', text: '协作流水线已启动。' });
    } catch (error) { setNotice({ type: 'error', text: `协作流水线启动失败：${error.message}` }); }
  };

  const pauseWorkflow = () => setRun(currentRun => currentRun ? { ...currentRun, status: currentRun.status === 'paused' ? 'running' : 'paused', message: currentRun.status === 'paused' ? '任务已恢复，继续等待执行端返回。' : '任务流已暂停。已经发出的网络请求不会被强制取消。' } : currentRun);
  const stopWorkflow = async () => {
    if (!run?.id) return;
    try { await api(`/api/workbench/tasks/${run.id}/cancel`, { method: 'POST' }); setRun(currentRun => currentRun ? { ...currentRun, status: 'cancelled', message: '任务已由服务端取消。', logs: [...currentRun.logs, '用户取消了任务'] } : currentRun); }
    catch (error) { setNotice({ type: 'error', text: `取消任务失败：${error.message}` }); }
  };

  const verifyWorkflow = async () => {
    if (!run?.id || run.status !== 'verifying') return;
    setNotice({ type: 'success', text: '正在运行测试与构建验证。' });
    try {
      const { task: latest } = await api(`/api/workbench/tasks/${run.id}/verify`, { method: 'POST' });
      setRun(currentRun => currentRun?.id === latest.id ? { ...currentRun, status: latest.status, message: latest.message, logs: [...currentRun.logs, '独立验证已通过，等待审查。'] } : currentRun);
      setNotice({ type: 'success', text: '验证已在后台启动，请等待任务状态更新。' });
    } catch (error) {
      verificationRequestedRef.current = null;
      setNotice({ type: 'error', text: `验证失败：${error.message}` });
      setRun(currentRun => currentRun ? { ...currentRun, status: 'failed', message: '独立验证失败，请展开详情查看日志。', logs: [...currentRun.logs, `验证失败：${error.message}`] } : currentRun);
    }
  };

  useEffect(() => {
    if (!run?.id || run.status !== 'verifying' || verificationRequestedRef.current === run.id) return;
    verificationRequestedRef.current = run.id;
    void verifyWorkflow();
  }, [run?.id, run?.status]);

  const reviewWorkflow = async decision => {
    if (!run?.id || run.status !== 'reviewing') return;
    const feedback = decision === 'approve' ? '' : String(window.prompt(decision === 'reject' ? '拒绝原因（可选）' : '请填写需要修改的内容') || '').trim();
    if (decision === 'request_changes' && !feedback) return setNotice({ type: 'error', text: '打回重验需要填写修改意见。' });
    try {
      const { task: latest } = await api(`/api/workbench/tasks/${run.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, feedback }) });
      setRun(currentRun => currentRun?.id === latest.id ? { ...currentRun, status: latest.status, message: latest.message, logs: [...currentRun.logs, decision === 'approve' ? '人工审查通过' : decision === 'reject' ? '人工审查拒绝' : `审查要求修改：${feedback}`] } : currentRun);
      setNotice({ type: decision === 'reject' ? 'error' : 'success', text: decision === 'approve' ? '任务已完成。' : decision === 'reject' ? '任务已拒绝。' : '任务已打回，等待重新验证。' });
    } catch (error) { setNotice({ type: 'error', text: `审查处理失败：${error.message}` }); }
  };

  const gateWorkflow = async decision => {
    if (!run?.id || run.status !== 'waiting_approval') return;
    const feedback = decision === 'interrupt' ? String(window.prompt('请填写补充意见') || '').trim() : '';
    try {
      const { task: latest } = await api(`/api/workbench/tasks/${run.id}/gate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, feedback }) });
      setRun(currentRun => currentRun?.id === latest.id ? { ...currentRun, status: latest.status, message: latest.message, logs: [...currentRun.logs, decision === 'allow' ? '审批已允许继续' : decision === 'deny' ? '审批已拒绝执行' : `执行已打断：${feedback || '未提供意见'}`] } : currentRun);
      setNotice({ type: decision === 'deny' ? 'error' : 'success', text: decision === 'allow' ? '已允许执行。' : decision === 'deny' ? '已拒绝执行。' : '已打断执行并补充意见。' });
    } catch (error) { setNotice({ type: 'error', text: `审批处理失败：${error.message}` }); }
  };

  const sandboxAction = async action => {
    if (!run?.id) return;
    try {
      const { task: latest, patch } = await api(`/api/workbench/tasks/${run.id}/${action}`, { method: 'POST' });
      if (action === 'merge' && patch) { const blob = new Blob([patch], { type: 'text/plain' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${run.id}.patch`; link.click(); URL.revokeObjectURL(link.href); }
      setRun(currentRun => currentRun ? { ...currentRun, status: latest.status, message: latest.message, sandboxPath: action === 'discard' ? null : currentRun.sandboxPath, logs: [...currentRun.logs, action === 'merge' ? '补丁已导出，未自动合并。' : '隔离目录已丢弃。'] } : currentRun);
      setNotice({ type: 'success', text: action === 'merge' ? '补丁已导出。' : '隔离目录已丢弃。' });
    } catch (error) { setNotice({ type: 'error', text: `处理隔离目录失败：${error.message}` }); }
  };

  return <div className="aube-page-overlay workbench-page"><div className="aube-page-scroll workbench-scroll">
    <header className="workbench-header"><div><span className="workbench-kicker">COCHPIA WORKSPACE</span><h2>工作区</h2><p>模型、代码和工具在这里集中配置。</p></div><div className="workbench-summary"><button type="button" className="workbench-primary" onClick={startCollaboration} disabled={!task.trim() || Boolean(run && !['completed', 'failed', 'cancelled'].includes(run.status))}><FeatherIcon name="layers" size={15} />协作开发</button><span className="workbench-summary-number">{connectedCount}<small>/ 5</small></span><span>连接就绪</span></div></header>
    <section className="workbench-model-panel" aria-labelledby="workbench-model-title"><div className="workbench-detail-head"><div><span className="workbench-eyebrow">MODEL DIRECTORY</span><h3 id="workbench-model-title">模型配置</h3></div><StatusPill connected={Boolean(selectedProviderInfo?.ready)} /></div><div className="workbench-model-controls"><label>模型供应商<select value={selectedProvider} onChange={onSelectProvider}>{models.providers.map(provider => <option key={provider.provider} value={provider.provider} disabled={!provider.ready}>{provider.label}{provider.ready ? '' : ' · 未配置'}</option>)}</select></label><label>模型<select value={selectedModel} onChange={onSelectModel} disabled={!selectedProviderInfo?.ready}>{providerModelOptions(selectedProviderInfo).map(item => <option key={item} value={item}>{item}</option>)}</select></label><button type="button" className="workbench-secondary" disabled={!selectedProviderInfo?.ready || tests[selectedProvider]?.state === 'testing'} onClick={() => onTestProvider(selectedProviderInfo)}>{tests[selectedProvider]?.state === 'testing' ? '测试中…' : '测试连接'}</button><button type="button" className="workbench-primary" disabled={!selectedProviderInfo?.ready} onClick={() => onSaveSelection(selectedProvider, selectedModel)}>用于当前会话</button></div>{tests[selectedProvider]?.state === 'success' && <p className="workbench-note">连接成功 · {tests[selectedProvider].result.latencyMs}ms</p>}{tests[selectedProvider]?.state === 'error' && <p className="workbench-note">{tests[selectedProvider].message}</p>}</section>
    <section className="workbench-grid" aria-label="工作区连接分区">{Object.keys(integrationMeta).map(id => <IntegrationCard key={id} id={id} selected={selected === id} value={integrations[id]} onSelect={setSelected} />)}</section>
    <section className="workbench-detail" aria-labelledby="workbench-detail-title"><div className="workbench-detail-head"><div><span className="workbench-eyebrow">{meta.eyebrow}</span><h3 id="workbench-detail-title">{meta.label}连接</h3></div><StatusPill connected={current.connected} /></div>
      {selected === 'github' ? <div className="workbench-form"><label>仓库地址<input value={current.repo} onChange={event => updateCurrent({ repo: event.target.value })} placeholder="https://github.com/owner/repository" /></label><label>默认分支<input value={current.branch} onChange={event => updateCurrent({ branch: event.target.value })} placeholder="main" /></label><div className="workbench-actions"><button type="button" className="workbench-primary" onClick={openGithub}><FeatherIcon name="upload" size={16} />直接打开 GitHub</button><button type="button" className="workbench-secondary" onClick={testConnection}>保存连接</button></div><p className="workbench-note">GitHub 凭据由 GitHub CLI 或浏览器登录管理，本页面不保存 token。</p></div> : <div className="workbench-form"><label>服务端执行器<input value={current.connected ? 'Cochpia Server' : '未就绪'} readOnly /></label><label>关联仓库<input value={current.repo} onChange={event => updateCurrent({ repo: event.target.value })} placeholder="可选，默认使用 GitHub 仓库" /></label><div className="workbench-actions"><button type="button" className="workbench-secondary" onClick={testConnection}><FeatherIcon name="eye" size={16} />检查状态</button></div><p className="workbench-note">执行器由 Cochpia 服务端管理，浏览器不保存或访问 Agent 凭据。</p></div>}
    </section>
    {selected !== 'github' && <section className="workbench-task" aria-labelledby="workbench-task-title"><div><span className="workbench-eyebrow">TASK DISPATCH</span><h3 id="workbench-task-title">部署任务到 {meta.label}</h3><p>{current.connected ? '任务会携带仓库地址、分支和提交时间，接口由服务端执行。' : `${meta.label} 当前未启用，连接成功后才可派发任务。`}</p></div><textarea value={task} onChange={event => setTask(event.target.value)} placeholder="例如：检查移动端布局，修复溢出问题并运行测试…" rows="3" disabled={!current.connected} /><button type="button" className="workbench-primary" onClick={deployTask} disabled={!current.connected}><FeatherIcon name="arrowUp" size={16} />发送任务</button></section>}
    <WorkflowPanel run={run} expanded={workflowExpanded} onToggle={() => setWorkflowExpanded(value => !value)} onPause={pauseWorkflow} onStop={stopWorkflow} onVerify={verifyWorkflow} onReview={reviewWorkflow} onGate={gateWorkflow} onSandboxAction={sandboxAction} />
    {notice && <div className={`workbench-notice ${notice.type}`} role="status"><FeatherIcon name={notice.type === 'success' ? 'check' : 'fileText'} size={16} /><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><FeatherIcon name="x" size={15} /></button></div>}
  </div></div>;
}
