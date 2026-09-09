import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { commandFor, redactOutput, resolveVerificationWorkdir, selectVerificationChecks } from './verifier.js';

test('verifier maps acceptance text to the fixed npm checks', () => {
  assert.equal(commandFor('构建通过'), 'build');
  assert.equal(commandFor('测试通过'), 'test');
  assert.deepEqual(selectVerificationChecks(['测试通过', '构建通过', '构建通过']), ['test', 'build']);
  assert.deepEqual(selectVerificationChecks(['审查结论通过']), ['test', 'build']);
});

test('verifier redacts credentials and truncates output', () => {
  const output = redactOutput(`Bearer secret-token credential-placeholder ${'x'.repeat(20000)}`);
  assert.match(output, /Bearer \[redacted\]/);
  assert.match(output, /\[redacted\]/);
  assert.ok(output.length <= 12000);
});

test('verifier only accepts workdirs inside the workspace', () => {
  const root = path.resolve('C:/workspace/cochpia');
  assert.equal(resolveVerificationWorkdir(root, 'client'), path.join(root, 'client'));
  assert.throws(() => resolveVerificationWorkdir(root, '..'), error => error.code === 'TASK_WORKDIR_INVALID');
});
