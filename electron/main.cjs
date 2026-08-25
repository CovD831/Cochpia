const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const DEFAULT_PORT = 8787;
const PROVIDERS = new Set(['openai', 'deepseek', 'qwen', 'glm', 'kimi', 'minimax', 'siliconflow', 'anthropic', 'gemini', 'mock']);
let mainWindow;
let apiProcess;
let apiPort = DEFAULT_PORT;
let stopping = false;

function runtimeRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath();
}

function appPath(...parts) {
  return path.join(runtimeRoot(), ...parts);
}

function dataDirectory() {
  return path.join(app.getPath('userData'), 'data');
}

function modelConfigPath() {
  return path.join(app.getPath('userData'), 'model-config.json');
}

function defaultModelConfig() {
  return { version: 1, activeProvider: 'mock', providers: {} };
}

async function readModelConfig() {
  try {
    const raw = JSON.parse(await fsp.readFile(modelConfigPath(), 'utf8'));
    return {
      ...defaultModelConfig(),
      ...raw,
      activeProvider: PROVIDERS.has(raw.activeProvider) ? raw.activeProvider : 'mock',
      providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {}
    };
  } catch {
    return defaultModelConfig();
  }
}

function decryptKey(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function encryptKey(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    const error = new Error('macOS 安全存储不可用，未保存 API Key');
    error.code = 'DESKTOP_SECURE_STORAGE_UNAVAILABLE';
    throw error;
  }
  return safeStorage.encryptString(value).toString('base64');
}

function providerKey(config, provider) {
  return decryptKey(config.providers?.[provider]?.apiKeyEncrypted);
}

function publicModelConfig(config) {
  const providers = {};
  for (const provider of PROVIDERS) {
    const item = config.providers?.[provider] || {};
    const key = providerKey(config, provider);
    providers[provider] = {
      model: String(item.model || ''),
      apiURL: String(item.apiURL || ''),
      configured: Boolean(key && item.model),
      keyHint: key ? `••••${key.slice(-4)}` : ''
    };
  }
  return {
    available: true,
    secureStorage: safeStorage.isEncryptionAvailable(),
    activeProvider: config.activeProvider || 'mock',
    providers
  };
}

async function writeModelConfig(config) {
  await fsp.mkdir(path.dirname(modelConfigPath()), { recursive: true });
  await fsp.writeFile(modelConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function runtimeEnvironment(config, port) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MODEL_|DATABASE_URL$|SUPABASE_|MEMORY_MODULE_|.*(?:API_KEY|TOKEN|SECRET|PASSWORD).*)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development',
    PORT: String(port),
    CLIENT_ORIGIN: `http://127.0.0.1:${port}`,
    STORAGE_PROVIDER: 'json',
    AUTH_MODE: 'off',
    MEMORY_TENANT_ID: 'desktop-local-tenant',
    MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS: 'true',
    COCHPIA_DATA_DIR: dataDirectory(),
    MODEL_PROVIDER: config.activeProvider || 'mock',
    MODEL_NAME: '',
    MODEL_API_KEY: ''
  });
  for (const provider of PROVIDERS) {
    const item = config.providers?.[provider] || {};
    const key = providerKey(config, provider);
    if (key) env[`MODEL_${provider.toUpperCase()}_API_KEY`] = key;
    if (item.model) env[`MODEL_${provider.toUpperCase()}_NAME`] = item.model;
    if (item.apiURL) env[`MODEL_${provider.toUpperCase()}_API_URL`] = item.apiURL;
  }
  const active = config.providers?.[config.activeProvider] || {};
  env.MODEL_NAME = active.model || '';
  env.MODEL_API_KEY = providerKey(config, config.activeProvider) || '';
  return env;
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/api/version`, response => {
      response.resume();
      resolve(false);
    });
    request.once('error', () => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    request.setTimeout(500, () => request.destroy());
  });
}

async function findPort() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 30; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  return 0;
}

function waitForReady(port, timeoutMs = 25_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('Cochpia 本地服务启动超时'));
      const request = http.get(`http://127.0.0.1:${port}/api/version`, response => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        setTimeout(check, 250);
      });
      request.on('error', () => setTimeout(check, 250));
      request.setTimeout(1000, () => request.destroy());
    };
    check();
  });
}

async function startApi() {
  if (apiProcess && !apiProcess.killed) return;
  const config = await readModelConfig();
  apiPort = await findPort();
  if (!apiPort) throw new Error('没有可用的本地端口');
  apiProcess = spawn(process.execPath, [appPath('server', 'index.js')], {
    cwd: runtimeRoot(),
    env: { ...runtimeEnvironment(config, apiPort), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  apiProcess.stdout.on('data', chunk => console.log(`[cochpia-api] ${String(chunk).trim()}`));
  apiProcess.stderr.on('data', chunk => console.error(`[cochpia-api] ${String(chunk).trim()}`));
  apiProcess.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      const message = `本地服务已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:server-error', message);
    }
  });
  await waitForReady(apiPort);
}

async function stopApi() {
  const child = apiProcess;
  apiProcess = null;
  if (!child || child.killed) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function restartApi() {
  await stopApi();
  await startApi();
  return { port: apiPort, ready: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'Cochpia',
    backgroundColor: '#fbf1f4',
    webPreferences: {
      preload: appPath('electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${apiPort}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function clearDesktopWebCaches() {
  if (!app.isPackaged) return;
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
}

ipcMain.handle('desktop:get-info', async () => ({ platform: process.platform, isPackaged: app.isPackaged, apiPort }));
ipcMain.handle('desktop:get-model-config', async () => publicModelConfig(await readModelConfig()));
ipcMain.handle('desktop:save-model-config', async (_event, payload = {}) => {
  const provider = String(payload.provider || '').trim();
  if (!PROVIDERS.has(provider)) throw new Error('不支持的模型供应商');
  const config = await readModelConfig();
  const current = config.providers[provider] || {};
  const apiKey = String(payload.apiKey || '').trim();
  const model = String(payload.model || '').trim();
  const apiURL = String(payload.apiURL || '').trim();
  if (provider !== 'mock' && !model) throw new Error('云端模型必须填写模型名');
  if (provider !== 'mock' && !apiKey && !current.apiKeyEncrypted && payload.clearKey !== true) throw new Error('请填写 API Key');
  if (apiURL) {
    try {
      const parsed = new URL(apiURL);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    } catch {
      throw new Error('API 地址必须是有效的 http 或 https URL');
    }
  }
  if (apiKey) current.apiKeyEncrypted = encryptKey(apiKey);
  if (payload.clearKey === true) delete current.apiKeyEncrypted;
  if (model) current.model = model;
  else delete current.model;
  if (apiURL) current.apiURL = apiURL;
  else delete current.apiURL;
  config.providers[provider] = current;
  if (payload.activate === true) config.activeProvider = provider;
  if (payload.clearKey === true && config.activeProvider === provider) config.activeProvider = 'mock';
  await writeModelConfig(config);
  await restartApi();
  return publicModelConfig(config);
});
ipcMain.handle('desktop:open-data-folder', async () => {
  await fsp.mkdir(dataDirectory(), { recursive: true });
  return shell.openPath(dataDirectory());
});
ipcMain.handle('desktop:show-about', () => dialog.showMessageBox(mainWindow, { type: 'info', title: 'Cochpia', message: 'Cochpia macOS', detail: '本地桌面版 · 数据默认保存在当前 Mac 的 Application Support。' }));

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Cochpia', submenu: [{ role: 'about', label: '关于 Cochpia' }, { type: 'separator' }, { role: 'quit', label: '退出 Cochpia' }] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' }
    ] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'reload', label: '重新加载' }, { role: 'toggledevtools', label: '开发者工具' }] }
  ]));
  try {
    await clearDesktopWebCaches();
    await startApi();
    createWindow();
  } catch (error) {
    console.error(error);
    await dialog.showMessageBox({ type: 'error', title: 'Cochpia 无法启动', message: error.message, detail: `数据目录：${dataDirectory()}` });
    app.quit();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', event => {
  if (stopping) return;
  stopping = true;
  event.preventDefault();
  stopApi().finally(() => app.exit(0));
});
