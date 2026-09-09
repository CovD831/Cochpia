import { spawn } from 'node:child_process';

export class CodexClientError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'CodexClientError'; this.code = code; }
}

export function createCodexClient({ cwd = process.cwd(), timeoutMs = 10 * 60 * 1000, command = process.env.CODEX_BIN || 'codex', onRequest = async () => ({ decision: 'decline' }) } = {}) {
  let child;
  let sequence = 0;
  let buffer = '';
  const pending = new Map();

  const send = (method, params = {}, expectResponse = true) => new Promise((resolve, reject) => {
    const id = ++sequence;
    if (expectResponse) pending.set(id, { resolve, reject });
    try { child.stdin.write(`${JSON.stringify({ method, id, params })}\n`); }
    catch (error) { pending.delete(id); reject(new CodexClientError('CODEX_WRITE_FAILED', 'Codex request could not be written', error)); }
  });

  const handle = async payload => {
    if (payload.id !== undefined && pending.has(payload.id)) {
      const request = pending.get(payload.id); pending.delete(payload.id);
      if (payload.error) request.reject(new CodexClientError('CODEX_RPC_ERROR', payload.error.message || 'Codex RPC error'));
      else request.resolve(payload.result);
      return;
    }
    if (payload.method && payload.id !== undefined) {
      const decision = await onRequest(payload);
      child.stdin.write(`${JSON.stringify({ id: payload.id, result: decision })}\n`);
    }
  };

  const run = async (message, onEvent = () => {}) => {
    child = spawn(command, ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    child.stderr.on('data', () => {});
    let completedResolve;
    let completedReject;
    const completed = new Promise((resolve, reject) => { completedResolve = resolve; completedReject = reject; });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      while (true) {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        let line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try { const payload = JSON.parse(line); void handle(payload); onEvent(payload); if (payload.method === 'turn/completed') completedResolve(payload); } catch { /* Ignore malformed process noise. */ }
      }
    });
    const exitPromise = new Promise((_, reject) => child.once('error', error => reject(new CodexClientError('CODEX_NOT_AVAILABLE', 'Codex App Server is unavailable', error))));
    const timer = setTimeout(() => close(), timeoutMs);
    try {
      await Promise.race([send('initialize', { clientInfo: { name: 'cochpia', title: 'Cochpia Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true } }), exitPromise]);
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
      const thread = await send('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspaceWrite' });
      const threadId = thread?.thread?.id || thread?.id;
      if (!threadId) throw new CodexClientError('CODEX_THREAD_INVALID', 'Codex did not return a thread ID');
      await send('turn/start', { threadId, input: [{ type: 'text', text: message }] });
      await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new CodexClientError('CODEX_TIMEOUT', 'Codex turn timed out')), timeoutMs))]);
    } finally { clearTimeout(timer); close(); }
  };

  const close = () => { for (const item of pending.values()) item.reject(new CodexClientError('CODEX_CLOSED', 'Codex connection closed')); pending.clear(); if (child && !child.killed) child.kill(); child = null; };
  return { run, close };
}
