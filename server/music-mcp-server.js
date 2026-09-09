/**
 * Music MCP Server (stdio)
 *
 * 这是 netease-music-adapter.js 通过 stdio 调用的那个 MCP server 本体。
 * 它实现了 MCP 协议（JSON-RPC 2.0 over stdio，Content-Length 帧），
 * 提供 search_song / play_track / play_song / pause / resume / next_song /
 * stop / get_status / get_listening_context 等工具。
 *
 * 真实播放依赖本机的 `neteasecli`（网易云命令行客户端）+ `mpv` 播放器。
 * 如果两者都不可用，会自动回退到 mock 模式，保证链路能跑通。
 *
 * 启动方式（与 netease-music-adapter 的默认配置对应）：
 *   node server/music-mcp-server.js
 */

import { spawn, execFileSync } from 'node:child_process';

// ---------- 工具函数 ----------

const hasCommand = value => {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [value], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const run = (command, args = []) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.stderr.on('data', chunk => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} exited with code ${code}: ${err.trim()}`));
    });
  });

const parseJson = text => {
  try { return JSON.parse(text); } catch { return null; }
};

// ---------- 播放器状态 ----------

function createPlayer({ command = 'neteasecli', mpvCommand = 'mpv' } = {}) {
  const neteaseAvailable = hasCommand(command);
  const mpvAvailable = hasCommand(mpvCommand);
  const mock = !neteaseAvailable || !mpvAvailable;

  let current = null;
  let state = 'stopped';
  let queue = [];

  const mockTrack = (query, index = 0) => ({
    id: `mock-${index + 1}`,
    title: query || 'Quiet Morning',
    artist: 'Cochpia Ambient Library',
    album: 'Local Preview',
    durationMs: 180000,
    coverUrl: '',
    source: 'mock'
  });

  const status = () => ({
    source: mock ? 'mock' : 'netease',
    state,
    track: current,
    queue,
    updatedAt: new Date().toISOString()
  });

  return {
    get mock() { return mock; },
    get neteaseAvailable() { return neteaseAvailable; },
    get mpvAvailable() { return mpvAvailable; },

    async search(query) {
      if (mock) return [mockTrack(query, 0), mockTrack(`${query || 'Ambient'} II`, 1)];
      const raw = await run(command, ['search', query]);
      const parsed = parseJson(raw);
      const items = parsed?.result?.songs || parsed?.songs || parsed?.items || [];
      return items.map((song, i) => ({
        id: String(song.id ?? song.songId ?? i + 1),
        title: song.name || song.title || '',
        artist: song.artists?.map(a => a.name).join(', ') || song.artist || '',
        album: song.album?.name || song.albumName || '',
        durationMs: Number(song.duration || song.dt || 0),
        coverUrl: song.album?.picUrl || song.picUrl || '',
        source: 'netease'
      }));
    },

    async playTrack(track) {
      if (mock) { current = track || mockTrack(); state = 'playing'; return status(); }
      const id = track?.id ?? track?.songId;
      if (id) await run(command, ['play', String(id)]);
      else await run(command, ['play', track?.title || '']);
      current = track; state = 'playing'; return status();
    },

    async playSong(query) {
      if (mock) { current = mockTrack(query); state = 'playing'; return status(); }
      await run(command, ['play', query]);
      current = { id: '', title: query, artist: '', album: '', durationMs: 0, coverUrl: '', source: 'netease' };
      state = 'playing'; return status();
    },

    async pause() {
      if (!mock) await run(command, ['pause']);
      state = 'paused'; return status();
    },

    async resume() {
      if (!mock) await run(command, ['play']);
      state = 'playing'; return status();
    },

    async next() {
      if (mock) { current = mockTrack('Next ambient track', 1); state = 'playing'; return status(); }
      await run(command, ['next']);
      state = 'playing'; return status();
    },

    async stop() {
      if (!mock) await run(command, ['stop']);
      state = 'stopped'; return status();
    },

    async getStatus() { return status(); },

    async listeningContext() {
      return {
        source: mock ? 'mock' : 'netease',
        track: current,
        lyrics: '',
        aiContext: current ? `Currently listening to ${current.title} by ${current.artist}.` : ''
      };
    }
  };
}

// ---------- MCP 协议层（stdio + Content-Length 帧） ----------

function createMcpServer(player) {
  const tools = {
    search_song: {
      description: 'Search songs by keyword',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async ({ query }) => ({ items: await player.search(query) })
    },
    play_track: {
      description: 'Play a specific track by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, songId: { type: 'string' } } },
      handler: async args => ({ track: (await player.playTrack(args)).track })
    },
    play_song: {
      description: 'Play a song by query string',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async ({ query }) => ({ track: (await player.playSong(query)).track })
    },
    pause: { description: 'Pause playback', inputSchema: { type: 'object', properties: {} }, handler: async () => player.pause() },
    resume: { description: 'Resume playback', inputSchema: { type: 'object', properties: {} }, handler: async () => player.resume() },
    next_song: { description: 'Skip to next song', inputSchema: { type: 'object', properties: {} }, handler: async () => player.next() },
    stop: { description: 'Stop playback', inputSchema: { type: 'object', properties: {} }, handler: async () => player.stop() },
    get_status: { description: 'Get current playback status', inputSchema: { type: 'object', properties: {} }, handler: async () => player.getStatus() },
    get_listening_context: { description: 'Get listening context for AI', inputSchema: { type: 'object', properties: {} }, handler: async () => player.listeningContext() }
  };

  const send = payload => {
    const body = JSON.stringify(payload);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  };

  const handle = async message => {
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cochpia-music', version: '0.1.0' } } });
    }
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
    }
    if (method === 'tools/call') {
      const tool = tools[params.name];
      if (!tool) {
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${params.name}` } });
      }
      try {
        const result = await tool.handler(params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } catch (error) {
        return send({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } });
      }
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  };

  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.length) {
      const separator = buffer.indexOf('\r\n\r\n');
      const alternateSeparator = buffer.indexOf('\n\n');
      const headerEnd = separator >= 0 && (alternateSeparator < 0 || separator < alternateSeparator) ? separator : alternateSeparator;
      if (headerEnd < 0) return;
      const headers = buffer.slice(0, headerEnd);
      const match = headers.match(/content-length\s*:\s*(\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + (headerEnd === separator ? 4 : 2)); continue; }
      const bodyStart = headerEnd + (headerEnd === separator ? 4 : 2);
      const length = Number(match[1]);
      if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < length) return;
      const body = Buffer.from(buffer.slice(bodyStart), 'utf8').subarray(0, length).toString('utf8');
      buffer = Buffer.from(buffer.slice(bodyStart), 'utf8').subarray(length).toString('utf8');
      try { handle(JSON.parse(body)); } catch { /* ignore malformed frames */ }
    }
  });
}

// ---------- 入口 ----------

const player = createPlayer({
  command: process.env.MUSIC_MCP_NETEASE_CLI || 'neteasecli',
  mpvCommand: process.env.MUSIC_MCP_MPV || 'mpv'
});

if (player.mock) {
  process.stderr.write(`[music-mcp-server] neteasecli/mpv not found, running in MOCK mode\n`);
} else {
  process.stderr.write(`[music-mcp-server] running with neteasecli + mpv\n`);
}

createMcpServer(player);
