import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createClaudeClient } from './claude-client.js';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

test('Claude client starts stream-json with bounded permissions and resolves result events', async () => {
  let args;
  const proc = fakeProcess();
  const client = createClaudeClient({ command: 'claude-test', timeoutMs: 500, maxTurns: 7, spawnProcess: (_command, receivedArgs) => { args = receivedArgs; return proc; } });
  const events = [];
  const pending = client.run('检查项目', event => events.push(event.type));
  assert.deepEqual(args, ['-p', '检查项目', '--output-format', 'stream-json', '--permission-mode', 'default', '--max-turns', '7']);
  proc.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"已检查"}]}}\n{"type":"result","result":"已完成","is_error":false}\n'));
  const result = await pending;
  assert.equal(result.result, '已完成');
  assert.deepEqual(events, ['assistant', 'result']);
});

test('Claude client reports non-zero process exits without leaking stderr', async () => {
  const proc = fakeProcess();
  const client = createClaudeClient({ timeoutMs: 500, spawnProcess: () => proc });
  const pending = client.run('执行任务');
  proc.stderr.emit('data', Buffer.from('secret-looking stderr')); // ignored by design
  proc.emit('exit', 2);
  await assert.rejects(pending, error => error.code === 'CLAUDE_EXITED');
});
