import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProposalPatch } from './code-modifier.js';

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cochpia-code-modifier-'));
const isolate = () => ({ root: makeRoot(), workspaceRoots: [] });

test('write operation creates a file under the workspace', () => {
  const ctx = isolate();
  const results = applyProposalPatch({ files: [{ path: 'notes/hello.md', content: 'hi there' }] }, { kind: 'file' }, ctx);
  assert.equal(results.length, 1);
  assert.equal(results[0].op, 'write');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'notes/hello.md'), 'utf8'), 'hi there');
  fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('edit operation replaces oldText exactly once', () => {
  const ctx = isolate();
  fs.mkdirSync(path.join(ctx.root, 'server/configs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'server/configs/a.json'), '{"a":1}', 'utf8');
  const results = applyProposalPatch({ path: 'server/configs/a.json', oldText: '"a":1', newText: '"a":2' }, { kind: 'config' }, ctx);
  assert.equal(results[0].op, 'edit');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'server/configs/a.json'), 'utf8'), '{"a":2}');
  fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('config kind only allows server/configs paths', () => {
  const ctx = isolate();
  assert.throws(
    () => applyProposalPatch({ path: 'somewhere/else.json', content: '{}' }, { kind: 'config' }, ctx),
    error => error.code === 'PATCH_PATH_INVALID'
  );
  fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('path traversal and sensitive files are rejected', () => {
  const ctx = isolate();
  assert.throws(() => applyProposalPatch({ path: '../outside.txt', content: 'x' }, {}, ctx), error => error.code === 'PATCH_PATH_INVALID');
  assert.throws(() => applyProposalPatch({ path: '.env', content: 'SECRET=1' }, {}, ctx), error => error.code === 'PATCH_SENSITIVE_FILE');
  fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('edit fails when oldText is not found', () => {
  const ctx = isolate();
  fs.writeFileSync(path.join(ctx.root, 'a.txt'), 'hello', 'utf8');
  assert.throws(() => applyProposalPatch({ path: 'a.txt', oldText: 'nope', newText: 'x' }, {}, ctx), error => error.code === 'PATCH_EDIT_NOT_FOUND');
  fs.rmSync(ctx.root, { recursive: true, force: true });
});
