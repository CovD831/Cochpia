import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { XHS_TOOLS } from './xiaohongshu-tools.js';

// 工作模式只读工具：ls / read / grep / find。全部只读，不写文件、不执行命令，安全。
const ROOT = process.cwd();
const workspaceRoots = [ROOT, ...(process.env.COCHPIA_WORKSPACE_ROOTS || '').split(path.delimiter).filter(Boolean).map(item => path.resolve(item))];
const MAX_READ = 80 * 1024;
const MAX_RESULTS = 200;
const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.vite', 'Knowledge_Base']);

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth + 1);
    else if (entry.isFile()) yield full;
  }
}

const rel = p => path.relative(ROOT, p);

function assertWorkspacePath(candidate, { allowMissing = false } = {}) {
  const resolved = path.resolve(String(candidate || ''));
  const inside = workspaceRoots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!inside) throw new Error('路径不在允许的工作区目录内');
  if (!allowMissing && !fs.existsSync(resolved)) throw new Error('路径不存在');
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    const realInside = workspaceRoots.some(root => real === root || real.startsWith(`${root}${path.sep}`));
    if (!realInside) throw new Error('路径符号链接超出允许的工作区目录');
  } else {
    const parent = fs.realpathSync(path.dirname(resolved));
    const parentInside = workspaceRoots.some(root => parent === root || parent.startsWith(`${root}${path.sep}`));
    if (!parentInside) throw new Error('目标父目录不在允许的工作区目录内');
  }
  return resolved;
}

// 安全策略：拒绝读取可能含密钥的文件
const SENSITIVE_NAME = /(^|\.)env(\..*)?$|\.pem$|\.key$|\.p12$|credential|secret/i;

// 脱敏：隐藏密钥、token、密码等
const redact = text => String(text || '')
  .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
  .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['"]?)[^'"\s]+/gi, '$1[REDACTED]');

const CORE_WORK_TOOLS = [
  {
    name: 'ls',
    sideEffect: 'read',
    description: '列出目录内容（默认项目根目录），返回条目名和大小。',
    parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录路径，可选，默认项目根目录' } } },
    async execute(args = {}) {
      const dir = assertWorkspacePath(args.dir || '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 100);
      if (!entries.length) return '(空目录)';
      return entries.map(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return `📁 ${rel(full)}/`;
        const size = fs.statSync(full).size;
        return `📄 ${rel(full)} (${size}B)`;
      }).join('\n');
    }
  },
  {
    name: 'read',
    sideEffect: 'read',
    description: '读取文件内容，返回文本。用于查看代码、配置、文档。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要读取的文件路径（相对或绝对）' } }, required: ['path'] },
    async execute(args = {}) {
      const file = assertWorkspacePath(args.path || '');
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝读取该文件，可能包含敏感信息）';
      const stat = fs.statSync(file);
      if (!stat.isFile()) return `${rel(file)} 不是文件`;
      if (stat.size > MAX_READ) {
        return `文件过大（${stat.size}B），仅显示前 ${MAX_READ}B：\n` + fs.readFileSync(file, 'utf8').slice(0, MAX_READ) + '\n…(内容已截断)';
      }
      return fs.readFileSync(file, 'utf8');
    }
  },
  {
    name: 'grep',
    sideEffect: 'read',
    description: '在项目源码中搜索文本或正则，返回「文件:行号: 内容」。自动跳过 node_modules/.git/dist 等目录。',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: '要搜索的文本或正则表达式' } }, required: ['pattern'] },
    async execute(args = {}) {
      const raw = String(args.pattern || '');
      if (!raw) return '需要 pattern 参数';
      let regex;
      try { regex = new RegExp(raw, 'i'); } catch { regex = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
      const out = [];
      for (const file of walk(ROOT)) {
        if (out.length >= MAX_RESULTS) break;
        try {
          const content = fs.readFileSync(file, 'utf8');
          content.split('\n').forEach((line, i) => {
            if (out.length < MAX_RESULTS && regex.test(line)) out.push(redact(`${rel(file)}:${i + 1}: ${line.trim().slice(0, 180)}`));
          });
        } catch { /* 二进制或无法读取，跳过 */ }
      }
      return out.join('\n') || '(未找到匹配)';
    }
  },
  {
    name: 'find',
    sideEffect: 'read',
    description: '按文件名关键词查找文件，返回匹配的文件路径列表。',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '文件名关键词（不区分大小写）' } }, required: ['name'] },
    async execute(args = {}) {
      const keyword = String(args.name || '').toLowerCase();
      if (!keyword) return '需要 name 参数';
      const results = [];
      for (const file of walk(ROOT)) {
        if (rel(file).toLowerCase().includes(keyword)) results.push(rel(file));
        if (results.length >= MAX_RESULTS) break;
      }
      return results.join('\n') || '(未找到)';
    }
  },
  {
    name: 'write',
    sideEffect: 'write',
    risk: 'write',
    description: '创建或覆盖一个文件。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要写入的文件路径' }, content: { type: 'string', description: '文件完整内容' } }, required: ['path', 'content'] },
    requiresApproval: true,
    async execute(args = {}) {
      const file = assertWorkspacePath(args.path || '', { allowMissing: true });
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝写入敏感文件）';
      const content = String(args.content || '');
      fs.writeFileSync(file, content, 'utf8');
      return `已写入 ${rel(file)}（${content.length} 字符）`;
    }
  },
  {
    name: 'edit',
    sideEffect: 'write',
    risk: 'write',
    description: '替换文件中的一段文本（用 oldText 精确匹配，替换为 newText）。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '要修改的文件路径' }, oldText: { type: 'string', description: '要替换的原文（必须精确匹配）' }, newText: { type: 'string', description: '替换后的新文本' } }, required: ['path', 'oldText', 'newText'] },
    requiresApproval: true,
    async execute(args = {}) {
      const file = assertWorkspacePath(args.path || '');
      if (SENSITIVE_NAME.test(path.basename(file))) return '（安全策略：拒绝修改敏感文件）';
      const oldText = String(args.oldText || '');
      const newText = String(args.newText || '');
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes(oldText)) return `未找到要替换的文本（请确认 oldText 与文件内容完全一致）`;
      fs.writeFileSync(file, content.replace(oldText, newText), 'utf8');
      return `已修改 ${rel(file)}`;
    }
  },
  {
    name: 'bash',
    sideEffect: 'command',
    risk: 'execute',
    description: '执行一个 shell 命令（如 git status、npm test、node 脚本）。执行前会先征求用户确认。',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的 shell 命令' } }, required: ['command'] },
    requiresApproval: true,
    async execute(args = {}) {
      const command = String(args.command || '').trim();
      if (!command) return '需要 command 参数';
      if (command.length > 500) return '命令过长（超过 500 字符）';
      if (/(^|[;&|])\s*(rm|del|erase|rmdir|Remove-Item|Format-Volume)\b|\b(git\s+push|npm\s+publish|Invoke-WebRequest|curl|wget)\b/i.test(command)) return '安全策略：该命令被禁止';
      try {
        const output = execSync(command, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
        return output || '(命令执行成功，无输出)';
      } catch (error) {
        return `命令执行失败（exit ${error.status ?? '未知'}）：\n${(error.stdout || '') + (error.stderr || error.message)}`.slice(0, 4000);
      }
    }
  },
  {
    name: 'dispatch_task',
    sideEffect: 'command',
    risk: 'execute',
    description: '把具体开发任务派给外部 Agent 执行。target 可选 codex、pi 或 claude。任务描述要具体（做什么、涉及哪些文件、验收标准）。',
    parameters: { type: 'object', properties: { target: { type: 'string', description: '执行者：codex / pi / claude' }, task: { type: 'string', description: '具体的任务描述' } }, required: ['target', 'task'] },
    requiresApproval: true,
    async execute() { return 'dispatch_task 需要服务端上下文，请由调度器处理。'; }
  }
];

export const WORK_TOOLS = [...CORE_WORK_TOOLS, ...XHS_TOOLS];

export const findTool = name => WORK_TOOLS.find(tool => tool.name === name) || null;
export const getToolRisk = (name, args = {}) => {
  if (name === 'bash' && /\b(git\s+(push|merge)|deploy|publish|release)\b/i.test(String(args.command || ''))) return 'deploy';
  return findTool(name)?.risk || 'read';
};

export const toOpenAITools = () => WORK_TOOLS.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sideEffect: tool.sideEffect, risk: tool.risk || 'read', requiresApproval: Boolean(tool.requiresApproval) }));

export async function executeTool(name, args = {}) {
  const tool = findTool(name);
  if (!tool) return `未知工具：${name}`;
  try { return await tool.execute(args); }
  catch (error) { return `工具执行出错：${error.message}`; }
}
