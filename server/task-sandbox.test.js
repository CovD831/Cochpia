import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskSandbox, removeTaskSandbox, shouldIncludeSandboxPath } from './task-sandbox.js';

test('sandbox excludes repositories, dependencies, build output and credentials', () => {
  for (const name of ['.git', 'node_modules', 'dist', 'uploads', '.env', '.env.local']) assert.equal(shouldIncludeSandboxPath(name), false);
  assert.equal(shouldIncludeSandboxPath(path.join('client', 'src')), true);
});

test('sandbox falls back to a filtered copy without a git HEAD and cleans idempotently', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cochpia-sandbox-test-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'index.js'), 'ok');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  const sandbox = await createTaskSandbox({ root });
  assert.equal(sandbox.mode, 'copy');
  assert.equal(fs.existsSync(path.join(sandbox.path, 'index.js')), true);
  assert.equal(fs.existsSync(path.join(sandbox.path, '.env')), false);
  assert.equal(fs.existsSync(path.join(sandbox.path, 'node_modules')), false);
  await removeTaskSandbox(sandbox);
  await removeTaskSandbox(sandbox);
  assert.equal(fs.existsSync(sandbox.parent), false);
  fs.rmSync(root, { recursive: true, force: true });
});
