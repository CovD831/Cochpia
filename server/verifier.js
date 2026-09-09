import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 12000;
const COMMANDS = {
  test: ['npm', ['test']],
  build: ['npm', ['run', 'build']]
};

export const redactOutput = value => String(value || '')
  .replace(/(sk-[A-Za-z0-9]{8,})/g, '[redacted]')
  .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
  .slice(0, MAX_OUTPUT);

export const commandFor = item => {
  const text = String(item || '').toLowerCase();
  if (text.includes('build') || text.includes('构建')) return 'build';
  if (text.includes('test') || text.includes('测试') || text.includes('验证')) return 'test';
  return null;
};

export const selectVerificationChecks = acceptance => {
  const requested = (acceptance || []).map(commandFor).filter(Boolean);
  return [...new Set(requested.length ? requested : ['test', 'build'])];
};

export const resolveVerificationWorkdir = (root, workdir = '.') => {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkdir = path.resolve(resolvedRoot, workdir || '.');
  if (resolvedWorkdir !== resolvedRoot && !resolvedWorkdir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw Object.assign(new Error('Task workdir must be inside the workspace'), { code: 'TASK_WORKDIR_INVALID' });
  }
  return resolvedWorkdir;
};

function runCommand(name, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    const command = process.platform === 'win32' ? `${name}.cmd` : name;
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let output = '';
    let timedOut = false;
    const append = chunk => { output = `${output}${chunk.toString()}`.slice(-MAX_OUTPUT); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ name, args, ok: false, code: 'PROCESS_ERROR', output: redactOutput(`${output}\n${error.message}`) }); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ name, args, ok: !timedOut && code === 0, code: timedOut ? 'TIMEOUT' : code, output: redactOutput(output) });
    });
  });
}

export async function verifyAgentTask({ task, cwd = process.cwd() }) {
  const checks = selectVerificationChecks(task.spec?.acceptance);
  const results = [];
  const timeoutMs = Number(task.spec?.timeoutMs) || 10 * 60 * 1000;
  for (const check of checks) {
    const [name, args] = COMMANDS[check];
    results.push(await runCommand(name, args, cwd, timeoutMs));
    if (!results.at(-1).ok) break;
  }
  return { ok: results.every(result => result.ok), cwd: path.resolve(cwd), checks: results };
}
