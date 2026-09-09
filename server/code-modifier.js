import fs from 'node:fs';
import path from 'node:path';

// 自进化提案的「批准即应用」适配器。
// 原则：任何自我修改（skills/config/memory 文件）必须先走 proposal，review 批准后才由这里落盘。
// 安全护栏与 tools.js 保持一致：只允许写工作区目录、拒绝敏感文件、限制文件体积与数量。
//
// patch 契约（proposal.patch）：
//   { files: [ { path, content } | { path, oldText, newText } ] }
//   或单文件简写 { path, content } / { path, oldText, newText }
//   - content 存在 → 创建/覆盖文件
//   - oldText/newText 存在 → 精确替换（oldText 必须命中，否则报错）
// proposal.kind 用于约束可写根目录：
//   config  → server/configs/
//   skill   → skills/
//   memory  → Knowledge_Base/
//   其它 / 未指定 → 整个工作区

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 50;
const SENSITIVE_NAME = /(^|\.)env(\..*)?$|\.pem$|\.key$|\.p12$|credential|secret/i;

const KIND_ROOTS = Object.freeze({
  config: ['server/configs'],
  skill: ['skills'],
  memory: ['Knowledge_Base']
});

const patchError = (code, message) => Object.assign(new Error(message), { code });

function normalizeOperations(patch) {
  if (!patch || typeof patch !== 'object') return [];
  const ops = [];
  const add = entry => {
    if (!entry || typeof entry !== 'object') return;
    const op = {
      path: String(entry.path || '').replace(/\\/g, '/'),
      content: entry.content,
      oldText: entry.oldText,
      newText: entry.newText
    };
    if (!op.path) return;
    if (op.content === undefined && op.oldText === undefined && op.newText === undefined) return;
    ops.push(op);
  };
  if (Array.isArray(patch.files)) patch.files.slice(0, MAX_FILES).forEach(add);
  else if (patch.path) add(patch);
  return ops.slice(0, MAX_FILES);
}

function resolveTarget(relPath, kind, workspaceRoots) {
  const raw = String(relPath || '').replace(/\\/g, '/');
  if (!raw) throw patchError('PATCH_PATH_INVALID', 'Patch path is required');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw patchError('PATCH_PATH_INVALID', 'Patch path must be relative');
  const normalized = path.normalize(raw);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw patchError('PATCH_PATH_INVALID', 'Patch path must stay inside the workspace');
  }
  const root = workspaceRoots[0];
  const candidate = path.resolve(root, normalized);
  const insideWorkspace = workspaceRoots.some(workspaceRoot => candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${path.sep}`));
  if (!insideWorkspace) throw patchError('PATCH_PATH_INVALID', 'Patch path is outside the workspace');

  const allowedRoots = KIND_ROOTS[String(kind || '').trim()] || [];
  if (allowedRoots.length) {
    const insideKindRoot = allowedRoots.some(allowed => {
      const base = path.resolve(root, allowed);
      return candidate === base || candidate.startsWith(`${base}${path.sep}`);
    });
    if (!insideKindRoot) throw patchError('PATCH_PATH_INVALID', `kind "${kind}" only allows paths under ${allowedRoots.join(', ')}`);
  }
  return candidate;
}

export function applyProposalPatch(patch, proposal = {}, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const envRoots = (process.env.COCHPIA_WORKSPACE_ROOTS || '').split(path.delimiter).filter(Boolean).map(item => path.resolve(item));
  const workspaceRoots = [root, ...(options.workspaceRoots || envRoots)];
  const kind = String(proposal.kind || '').trim() || 'file';

  const operations = normalizeOperations(patch);
  if (!operations.length) throw patchError('PATCH_INVALID', 'Proposal patch must define at least one file operation');

  const results = [];
  for (const op of operations) {
    const file = resolveTarget(op.path, kind, workspaceRoots);
    const relFile = path.relative(root, file);
    if (SENSITIVE_NAME.test(path.basename(file))) {
      throw patchError('PATCH_SENSITIVE_FILE', `Refusing to modify sensitive file: ${relFile}`);
    }
    if (op.content !== undefined) {
      const content = String(op.content ?? '');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw patchError('PATCH_TOO_LARGE', `Patch content exceeds ${MAX_FILE_BYTES} bytes`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      results.push({ path: relFile, op: 'write', bytes });
    } else {
      const oldText = String(op.oldText ?? '');
      const newText = String(op.newText ?? '');
      if (!oldText) throw patchError('PATCH_EDIT_INVALID', 'edit operation requires non-empty oldText');
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes(oldText)) throw patchError('PATCH_EDIT_NOT_FOUND', `oldText not found in ${relFile}`);
      fs.writeFileSync(file, content.replace(oldText, newText), 'utf8');
      results.push({ path: relFile, op: 'edit' });
    }
  }
  return results;
}
