import { spawn } from 'node:child_process';

export class ClaudeClientError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'ClaudeClientError'; this.code = code; }
}

// Claude CLI print mode emits JSONL events; the server owns the process.
export function createClaudeClient({ cwd = process.cwd(), timeoutMs = 10 * 60 * 1000, maxTurns = 20, command = process.env.CLAUDE_BIN || 'claude', spawnProcess = spawn } = {}) {
  let child = null;
  let buffer = '';
  let settled = false;
  const close = () => { if (child && !child.killed) child.kill(); child = null; };
  const run = (message, onEvent = () => {}) => new Promise((resolve, reject) => {
    try { child = spawnProcess(command, ['-p', String(message), '--output-format', 'stream-json', '--permission-mode', 'default', '--max-turns', String(maxTurns)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch (error) { reject(new ClaudeClientError('CLAUDE_NOT_AVAILABLE', 'Claude CLI 不可用', error)); return; }
    settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result); close(); };
    const dataHandler = chunk => {
      buffer += chunk.toString();
      while (true) {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        let line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let payload; try { payload = JSON.parse(line); } catch { continue; }
        onEvent(payload);
        if (payload.type === 'result') {
          if (payload.is_error) finish(new ClaudeClientError(payload.error_code || 'CLAUDE_RUN_FAILED', payload.result || 'Claude 任务执行失败'));
          else finish(null, payload);
        }
      }
    };
    const timer = setTimeout(() => finish(new ClaudeClientError('CLAUDE_TIMEOUT', 'Claude 执行超时')), timeoutMs);
    child.stdout.on('data', dataHandler); child.stderr.on('data', () => {});
    child.once('error', error => finish(new ClaudeClientError('CLAUDE_NOT_AVAILABLE', 'Claude CLI 不可用', error)));
    child.once('exit', code => { if (!settled) finish(code === 0 ? new ClaudeClientError('CLAUDE_NO_RESULT', 'Claude 未返回最终结果') : new ClaudeClientError('CLAUDE_EXITED', `Claude 进程退出，状态码 ${code}`)); });
  });
  return { run, close };
}
