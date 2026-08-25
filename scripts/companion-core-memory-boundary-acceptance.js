import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = process.cwd();

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForReady(child, port) {
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode != null) throw new Error(`Cochpia server exited before readiness: ${output.slice(-4000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200 || response.status === 503) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Cochpia server: ${output.slice(-4000)}`);
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const port = await availablePort();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-memory-boundary-'));
const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'cochpia-memory-boundary-uploads-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    AUTH_MODE: 'off',
    STORAGE_PROVIDER: 'json',
    MODEL_PROVIDER: 'mock',
    COCHPIA_DATA_DIR: dataDir,
    COCHPIA_UPLOAD_DIR: uploadDir,
    MCP_WRITE_SERVICE_TOKEN: 'memory-boundary-service-token',
    MEMORY_TENANT_ID: 'memory-boundary-acceptance'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForReady(child, port);
  const request = async (pathName, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    return { response, body: await response.json().catch(() => null) };
  };
  const apiKey = 'api-memory-boundary-1';
  const apiBody = { content: 'api boundary memory', sensitivity: 'S0', idempotency_key: apiKey };
  const apiFirst = await request('/api/memories', { method: 'POST', body: JSON.stringify(apiBody) });
  const apiReplay = await request('/api/memories', { method: 'POST', body: JSON.stringify(apiBody) });
  assert.equal(apiFirst.response.status, 201);
  assert.equal(apiReplay.response.status, 201);
  assert.equal(apiFirst.body.id, apiReplay.body.id);

  const unauthorizedMcp = await request('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized', method: 'tools/call', params: { name: 'hold', arguments: { content: 'must not write' } } })
  });
  assert.equal(unauthorizedMcp.response.status, 403);
  assert.equal(unauthorizedMcp.body.error.code, 'MCP_WRITE_SERVICE_AUTH_REQUIRED');

  const mcpRequest = (id, name, args) => request('/mcp', {
    method: 'POST',
    headers: { 'x-mcp-service-token': 'memory-boundary-service-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  });
  const mcpBody = { content: 'mcp boundary memory', sensitivity: 'S0', idempotency_key: 'mcp-memory-boundary-1' };
  const mcpFirst = await mcpRequest('mcp-hold-1', 'hold', mcpBody);
  const mcpReplay = await mcpRequest('mcp-hold-2', 'hold', mcpBody);
  const mcpFirstMemory = JSON.parse(mcpFirst.body.result.content[0].text);
  const mcpReplayMemory = JSON.parse(mcpReplay.body.result.content[0].text);
  assert.equal(mcpFirst.response.status, 200);
  assert.equal(mcpReplay.response.status, 200);
  assert.equal(mcpFirstMemory.id, mcpReplayMemory.id);

  const growBody = { claim: 'boundary evidence', evidence: 'same source event should deduplicate', idempotency_key: 'mcp-grow-boundary-1' };
  const growFirst = await mcpRequest('mcp-grow-1', 'grow', growBody);
  const growReplay = await mcpRequest('mcp-grow-2', 'grow', growBody);
  const growFirstEvidence = JSON.parse(growFirst.body.result.content[0].text);
  const growReplayEvidence = JSON.parse(growReplay.body.result.content[0].text);
  assert.equal(growFirst.response.status, 200);
  assert.equal(growReplay.response.status, 200);
  assert.equal(growFirstEvidence.id, growReplayEvidence.id);
  assert.equal(growReplayEvidence.duplicate, true);
  const noStoreGrow = await mcpRequest('mcp-grow-no-store', 'grow', { claim: 'must not persist', evidence: 'do not store', storage_directive: 'do_not_store', idempotency_key: 'mcp-grow-no-store-1' });
  const noStoreGrowResult = JSON.parse(noStoreGrow.body.result.content[0].text);
  assert.equal(noStoreGrow.response.status, 200);
  assert.equal(noStoreGrowResult.status, 'accepted_no_store');

  const uploaded = await request('/api/upload', {
    method: 'POST',
    body: JSON.stringify({ name: 'boundary.txt', dataUrl: `data:text/plain;base64,${Buffer.from('boundary upload').toString('base64')}` })
  });
  assert.equal(uploaded.response.status, 200);
  const exported = await request('/api/export');
  assert.equal(exported.response.status, 200);
  assert.equal(exported.body.data.uploads.length, 1);
  assert.equal(exported.body.data.uploads[0].dataUrl.includes(Buffer.from('boundary upload').toString('base64')), true);
  const rawEvents = exported.body.data.memoryModule.rawEvents || [];
  assert.equal(rawEvents.some(event => event.metadata?.producer === 'memory-api-adapter'), true);
  assert.equal(rawEvents.some(event => event.metadata?.producer === 'mcp-adapter'), true);
  const uploadPath = path.join(uploadDir, exported.body.data.uploads[0].path.replace(/^uploads[\\/]/, ''));
  await access(uploadPath);

  const deleted = await request('/api/account', { method: 'DELETE', headers: { 'Idempotency-Key': 'memory-boundary-account-delete-1' } });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.manifest.components.find(item => item.id === 'application.uploads').status, 'completed');
  await assert.rejects(() => access(uploadPath));
  const afterDelete = await request('/api/export');
  assert.equal(afterDelete.response.status, 200);
  assert.equal(afterDelete.body.data.uploads.length, 0);

  console.log(JSON.stringify({
    event: 'companion_core_memory_boundary_acceptance_passed',
    apiHoldReplayDeduplicated: true,
    mcpHoldReplayDeduplicated: true,
    mcpGrowReplayDeduplicated: true,
    unauthorizedMcpWriteRejected: true,
    uploadExportedAndPurgedOnAccountDelete: true,
    collectorProvenanceRecorded: true
  }));
} finally {
  await stop(child);
  await rm(dataDir, { recursive: true, force: true });
  await rm(uploadDir, { recursive: true, force: true });
}
