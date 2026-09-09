import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_DIFF = 20000;
const MAX_PATCH = 120000;

const runGit = (args, cwd) => execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
export const shouldIncludeSandboxPath = (relative = '') => !String(relative).split(path.sep).some(part => part === '.git' || part === 'node_modules' || part === 'dist' || part === 'uploads' || /^\.env(?:\.|$)/i.test(part));

export async function createTaskSandbox({ root = process.cwd() } = {}) {
  const workspace = path.resolve(root);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cochpia-task-'));
  const worktree = path.join(parent, 'worktree');
  try {
    await runGit(['worktree', 'add', '--detach', worktree, 'HEAD'], workspace);
    return { path: worktree, root: workspace, parent, mode: 'git-worktree' };
  } catch (error) {
    // 新建仓库尚无 HEAD 时没有可供 worktree 使用的提交，退回到不含凭据的临时副本。
    try {
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.cpSync(workspace, worktree, {
        recursive: true,
        filter: source => {
          const relative = path.relative(workspace, source);
          if (!relative) return true;
          return shouldIncludeSandboxPath(relative);
        }
      });
      return { path: worktree, root: workspace, parent, mode: 'copy' };
    } catch (copyError) {
      fs.rmSync(parent, { recursive: true, force: true });
      throw Object.assign(new Error('无法创建任务隔离工作树'), { code: 'TASK_SANDBOX_CREATE_FAILED', cause: copyError });
    }
  }
}

export async function readTaskDiff(sandbox) {
  if (!sandbox?.path || sandbox.mode !== 'git-worktree') return '';
  try {
    const { stdout } = await runGit(['diff', '--no-ext-diff', '--stat', 'HEAD'], sandbox.path);
    return String(stdout || '').slice(0, MAX_DIFF);
  } catch { return ''; }
}

export async function readTaskPatch(sandbox) {
  if (!sandbox?.path || sandbox.mode !== 'git-worktree') return '';
  try {
    const { stdout } = await runGit(['diff', '--no-ext-diff', '--binary', 'HEAD'], sandbox.path);
    return String(stdout || '').slice(0, MAX_PATCH);
  } catch { return ''; }
}

export async function removeTaskSandbox(sandbox) {
  if (!sandbox?.path) return;
  try { await runGit(['worktree', 'remove', '--force', sandbox.path], sandbox.root); } catch { /* Best effort cleanup. */ }
  try { fs.rmSync(sandbox.parent || path.dirname(sandbox.path), { recursive: true, force: true }); } catch { /* Best effort cleanup. */ }
}

export async function cleanupOrphanTaskSandboxes({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('cochpia-task-')) continue;
    const target = path.join(os.tmpdir(), name);
    try {
      const stat = fs.statSync(target);
      if (now - stat.mtimeMs > maxAgeMs) fs.rmSync(target, { recursive: true, force: true });
    } catch { /* Ignore files removed concurrently. */ }
  }
  try { await runGit(['worktree', 'prune'], path.resolve(process.cwd())); } catch { /* Not a git repository. */ }
}
