/**
 * 小红书搜索工具（只读 + 结果落盘）
 *
 * 通过本机已运行的 xiaohongshu-mcp（HTTP，默认 http://localhost:18060/mcp）桥接，
 * 把「搜索笔记 / 看笔记详情 / 看用户主页 / 查登录态」暴露为 Cochpia 的只读工具。
 *
 * 结果处理策略：完整结果写入 Markdown 文件（默认 work/xhs/ 目录），
 * 工具只向模型返回「短摘要 + 文件路径」，避免大段内容撑爆上下文。
 * 模型如需细看，可用 read 工具读回对应文件。
 *
 * 安全边界：
 *  - 只暴露只读工具；点赞、评论、发布、收藏等写操作一律不暴露。
 *  - xiaohongshu-mcp 本身需要已登录（cookies.json），本模块不代管登录态。
 */

import fs from 'node:fs';
import path from 'node:path';

const XHS_MCP_URL = () => process.env.XHS_MCP_URL || 'http://localhost:18060/mcp';
const XHS_MCP_TIMEOUT_MS = () => Math.max(10_000, Number(process.env.XHS_MCP_TIMEOUT_MS || 120000));
const XHS_EXPORT_DIR = () => process.env.XHS_EXPORT_DIR || path.join(process.cwd(), 'work', 'xhs');

let sessionId = null;

async function xhsRpc(method, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), XHS_MCP_TIMEOUT_MS());
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const response = await fetch(XHS_MCP_URL(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal
    });
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应按错误处理 */ }
    if (!response.ok) {
      throw new Error(`小红书 MCP 请求失败 (HTTP ${response.status})：${payload?.error?.message || raw || '无响应'}`);
    }
    if (payload?.error) throw new Error(payload.error.message || '小红书 MCP 返回错误');
    return payload?.result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`小红书 MCP 请求超时（${XHS_MCP_TIMEOUT_MS()}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureXhsSession() {
  if (sessionId) return;
  await xhsRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cochpia', version: '0.1.0' }
  });
}

function textContent(result) {
  const list = Array.isArray(result?.content) ? result.content : [];
  const text = list.filter(item => item?.type === 'text').map(item => item?.text || '').join('\n');
  return text || '';
}

async function callXhsTool(name, args = {}) {
  await ensureXhsSession();
  const result = await xhsRpc('tools/call', { name, arguments: args || {} });
  return textContent(result);
}

const clip = (value, max = 400) => String(value ?? '').trim().slice(0, max);
const jsonParse = text => { try { return JSON.parse(text); } catch { return null; } };

// ---------- 落盘 ----------

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(value, fallback = 'result') {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned || fallback;
}

function saveMarkdown(filename, content) {
  const dir = XHS_EXPORT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const fmtTime = ms => { const n = Number(ms); return n ? new Date(n).toLocaleString('zh-CN') : ''; };
const md = (label, value) => value != null && value !== '' ? `- **${label}**：${value}\n` : '';

// ---------- 搜索 ----------

function buildSearchMarkdown(rawText, keyword, filters) {
  const data = jsonParse(rawText);
  if (!data) return clip(rawText, 8000) || '(空响应)';
  const feeds = Array.isArray(data.feeds) ? data.feeds : [];
  const lines = [
    `# 小红书搜索：${keyword}`,
    '',
    `- 抓取时间：${new Date().toLocaleString('zh-CN')}`,
    `- 结果数：${data.count ?? feeds.length}`,
    filters && Object.keys(filters).length ? `- 筛选：${JSON.stringify(filters)}` : null,
    ''
  ].filter(l => l !== null);
  if (!feeds.length) {
    lines.push('没有找到相关结果。');
    return lines.join('\n');
  }
  feeds.forEach((feed, i) => {
    const card = feed.noteCard || {};
    const user = card.user || {};
    const inter = card.interactInfo || {};
    const cover = card.cover || {};
    lines.push(`## ${i + 1}. ${clip(card.displayTitle || '(无标题)', 100)}`);
    lines.push('');
    lines.push(md('作者', `${user.nickname || user.nickName || ''}（userId: ${user.userId || ''}）`).trimEnd());
    lines.push(md('互动', `赞 ${inter.likedCount ?? 0} / 藏 ${inter.collectedCount ?? 0} / 评 ${inter.commentCount ?? 0} / 转发 ${inter.sharedCount ?? 0}`).trimEnd());
    lines.push(md('笔记ID', feed.id || '').trimEnd());
    lines.push(md('xsec_token', feed.xsecToken || '').trimEnd());
    if (cover.urlDefault) lines.push(md('封面', cover.urlDefault).trimEnd());
    lines.push('');
  });
  return lines.join('\n');
}

function searchSummary(data, keyword, file) {
  const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
  const top = feeds.slice(0, 5).map((f, i) => `${i + 1}. ${clip(f.noteCard?.displayTitle || '(无标题)', 40)}`).join('；');
  return `已搜索「${keyword}」，共 ${data?.count ?? feeds.length} 条，结果已保存到文件：${file}${top ? `\n前 ${Math.min(5, feeds.length)} 条：${top}` : ''}\n\n如需查看完整列表或某条详情，用 read 工具读取该文件。`;
}

// ---------- 笔记详情 ----------

function buildFeedDetailMarkdown(rawText) {
  const data = jsonParse(rawText);
  if (!data) return clip(rawText, 8000) || '(空响应)';
  const note = data?.data?.note || {};
  const user = note.user || {};
  const inter = note.interactInfo || {};
  const lines = [
    `# 笔记详情：${clip(note.title, 100) || '(无标题)'}`,
    '',
    md('作者', user.nickname || user.nickName || '').trimEnd(),
    md('笔记ID', note.noteId || '').trimEnd(),
    md('发布时间', fmtTime(note.time)).trimEnd(),
    md('互动', `赞 ${inter.likedCount ?? 0} / 藏 ${inter.collectedCount ?? 0} / 评 ${inter.commentCount ?? 0} / 转发 ${inter.sharedCount ?? 0}`).trimEnd(),
    note.video ? '- **类型**：视频（含视频直链）\n' : '',
    '',
    '## 正文',
    '',
    note.desc || '(无正文)',
    ''
  ];
  if (Array.isArray(note.imageList) && note.imageList.length) {
    lines.push(`## 图片（${note.imageList.length} 张）`, '');
    note.imageList.forEach((img, i) => { if (img.urlDefault) lines.push(`${i + 1}. ${img.urlDefault}`); });
    lines.push('');
  }
  const comments = data?.data?.comments?.list || [];
  if (Array.isArray(comments) && comments.length) {
    lines.push(`## 评论（前 ${comments.length} 条）`, '');
    comments.forEach((c, i) => {
      const author = c.user?.nickname || c.user?.nickName || c.nickname || '';
      lines.push(`${i + 1}. **${clip(author, 30)}**：${clip(c.content || c.text || '', 300)}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function feedDetailSummary(note, file) {
  const desc = clip(note?.desc || '', 200);
  return `已获取笔记详情，保存到文件：${file}\n标题：${clip(note?.title, 60) || '(无标题)'}\n作者：${note?.user?.nickname || ''}${desc ? `\n正文开头：${desc}` : ''}\n\n如需查看完整正文或评论，用 read 工具读取该文件。`;
}

// ---------- 用户主页 ----------

function buildUserProfileMarkdown(rawText) {
  const data = jsonParse(rawText);
  if (!data) return clip(rawText, 8000) || '(空响应)';
  const info = data?.userBasicInfo || data?.user || {};
  const gender = info.gender != null ? ['未知', '男', '女'][Number(info.gender)] ?? info.gender : '';
  const lines = [
    `# 用户主页：${clip(info.nickname || info.nickName, 60)}`,
    '',
    md('小红书号', info.redId).trimEnd(),
    md('简介', info.desc).trimEnd(),
    gender ? `- **性别**：${gender}\n` : '',
    md('IP 属地', info.ipLocation).trimEnd(),
    ''
  ];
  const interactions = Array.isArray(data.interactions) ? data.interactions : [];
  if (interactions.length) {
    lines.push(`- **互动**：${interactions.map(item => `${item.name || item.type} ${item.count ?? ''}`).join(' / ')}`, '');
  }
  const feeds = Array.isArray(data.feeds) ? data.feeds : [];
  if (feeds.length) {
    lines.push(`## 主页笔记（${feeds.length} 条）`, '');
    feeds.forEach((feed, i) => {
      const title = feed.noteCard?.displayTitle || feed.title || feed.displayTitle || '(无标题)';
      lines.push(`${i + 1}. ${clip(title, 100)}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function userProfileSummary(data, file) {
  const info = data?.userBasicInfo || data?.user || {};
  const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
  const top = feeds.slice(0, 5).map((f, i) => `${i + 1}. ${clip(f.noteCard?.displayTitle || f.title || '(无标题)', 40)}`).join('；');
  return `已获取用户主页，保存到文件：${file}\n昵称：${clip(info.nickname || info.nickName, 40)}${top ? `\n主页笔记（共 ${feeds.length} 条，前 5）：${top}` : ''}\n\n如需查看完整内容，用 read 工具读取该文件。`;
}

export const XHS_TOOLS = [
  {
    name: 'xhs_search',
    sideEffect: 'read',
    risk: 'read',
    description: '搜索小红书公开笔记（需要已登录）。完整结果写入 Markdown 文件，只返回摘要和文件路径。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        sort_by: { type: 'string', enum: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'], description: '排序依据，默认综合' },
        note_type: { type: 'string', enum: ['不限', '视频', '图文'], description: '笔记类型，默认不限' },
        publish_time: { type: 'string', enum: ['不限', '一天内', '一周内', '半年内'], description: '发布时间，默认不限' }
      },
      required: ['keyword']
    },
    async execute(args = {}) {
      const keyword = clip(args.keyword, 60);
      if (!keyword) return 'xhs_search 需要 keyword 参数';
      const filters = {};
      if (args.sort_by) filters.sort_by = args.sort_by;
      if (args.note_type) filters.note_type = args.note_type;
      if (args.publish_time) filters.publish_time = args.publish_time;
      try {
        const raw = await callXhsTool('search_feeds', { keyword, filters });
        const data = jsonParse(raw);
        const mdText = buildSearchMarkdown(raw, keyword, filters);
        const file = saveMarkdown(`搜索_${safeName(keyword)}_${timestamp()}.md`, mdText);
        return searchSummary(data, keyword, file);
      } catch (error) {
        return `小红书搜索失败：${error.message}`;
      }
    }
  },
  {
    name: 'xhs_feed_detail',
    sideEffect: 'read',
    risk: 'read',
    description: '获取小红书笔记详情（正文、作者、互动、图片/视频、评论）。完整结果写入 Markdown 文件，只返回摘要和文件路径。',
    parameters: {
      type: 'object',
      properties: {
        feed_id: { type: 'string', description: '笔记ID（来自 xhs_search 结果）' },
        xsec_token: { type: 'string', description: '访问令牌（来自 xhs_search 结果）' },
        load_all_comments: { type: 'boolean', description: '是否加载全部评论；默认 false 只取前10条一级评论' }
      },
      required: ['feed_id', 'xsec_token']
    },
    async execute(args = {}) {
      const feed_id = clip(args.feed_id, 80);
      const xsec_token = clip(args.xsec_token, 200);
      if (!feed_id || !xsec_token) return 'xhs_feed_detail 需要 feed_id 和 xsec_token（都从 xhs_search 结果里拿）';
      try {
        const raw = await callXhsTool('get_feed_detail', { feed_id, xsec_token, load_all_comments: Boolean(args.load_all_comments) });
        const data = jsonParse(raw);
        const mdText = buildFeedDetailMarkdown(raw);
        const title = safeName(data?.data?.note?.title, '笔记');
        const file = saveMarkdown(`笔记_${title}_${feed_id.slice(-8)}_${timestamp()}.md`, mdText);
        return feedDetailSummary(data?.data?.note, file);
      } catch (error) {
        return `获取笔记详情失败：${error.message}`;
      }
    }
  },
  {
    name: 'xhs_user_profile',
    sideEffect: 'read',
    risk: 'read',
    description: '查看指定小红书用户主页（简介、互动、笔记列表）。完整结果写入 Markdown 文件，只返回摘要和文件路径。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户ID（来自 xhs_search 结果的 userId）' },
        xsec_token: { type: 'string', description: '访问令牌（来自 xhs_search 结果）' },
        tab: { type: 'string', enum: ['note', 'fav', 'liked'], description: '主页 tab，默认 note（笔记）' }
      },
      required: ['user_id', 'xsec_token']
    },
    async execute(args = {}) {
      const user_id = clip(args.user_id, 80);
      const xsec_token = clip(args.xsec_token, 200);
      if (!user_id || !xsec_token) return 'xhs_user_profile 需要 user_id 和 xsec_token';
      try {
        const raw = await callXhsTool('user_profile', { user_id, xsec_token, tab: args.tab || 'note' });
        const data = jsonParse(raw);
        const mdText = buildUserProfileMarkdown(raw);
        const name = safeName(data?.userBasicInfo?.nickname || data?.user?.nickname, '用户');
        const file = saveMarkdown(`用户_${name}_${user_id.slice(-8)}_${timestamp()}.md`, mdText);
        return userProfileSummary(data, file);
      } catch (error) {
        return `获取用户主页失败：${error.message}`;
      }
    }
  },
  {
    name: 'xhs_check_login',
    sideEffect: 'read',
    risk: 'read',
    description: '检查小红书 MCP 的登录状态（是否可用搜索等能力）。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const raw = await callXhsTool('check_login_status');
        return raw || '(无响应)';
      } catch (error) {
        return `检查登录状态失败：${error.message}`;
      }
    }
  }
];
