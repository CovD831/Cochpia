import { createCodexClient } from '../codex-client.js';
import { createClaudeClient } from '../claude-client.js';
import { createTaskSandbox, readTaskDiff, removeTaskSandbox } from '../task-sandbox.js';
import { createAgentScheduler } from '../agent-scheduler.js';

export function createAgentRunner(deps) {
  const { state, agentTasks, createPiClient, activeAgentRuns, pendingAgentApprovals, taskEvent, recordTaskEvidence, workflowHooks } = deps;
  const runAgentTask = async task => {
    const text = agentTasks.buildInput(task);
    let output = '';
    let sandbox = null;
    try {
      sandbox = await createTaskSandbox({ root: process.cwd() });
      task.sandboxPath = sandbox.path;
      await taskEvent(task, 'sandbox_created', { workdir: sandbox.path });
      await agentTasks.transition(task, 'running', `${task.target} 执行器已启动`);
      if (task.target === 'pi') {
        const client = createPiClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs });
        activeAgentRuns.set(task.id, client);
        await client.prompt(text, async event => {
          if (event.type === 'message_update') output += String(event.assistantMessageEvent?.delta || '');
          await taskEvent(task, event.type || 'agent_event', { summary: String(event.assistantMessageEvent?.delta || event.type || '').slice(0, 1000) });
        });
        client.close();
      } else if (task.target === 'codex') {
        const client = createCodexClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs, onRequest: async request => {
          await agentTasks.transition(task, 'waiting_approval', 'Agent 请求用户审批');
          await agentTasks.addApproval(task, { method: request.method, requestId: request.id, command: request.params?.command, diff: request.params?.diff });
          const approvalKey = `${task.id}:${request.id}`;
          const decision = await new Promise(resolve => {
            const timeout = setTimeout(() => { pendingAgentApprovals.delete(approvalKey); resolve({ decision: 'decline' }); }, 5 * 60 * 1000);
            pendingAgentApprovals.set(approvalKey, value => { clearTimeout(timeout); pendingAgentApprovals.delete(approvalKey); resolve(value); });
          });
          await agentTasks.transition(task, 'running', '用户审批已处理');
          return decision;
        }});
        activeAgentRuns.set(task.id, client);
        await client.run(text, async event => {
          const delta = event.method === 'item/agentMessage/delta' ? event.params?.delta : '';
          output += String(delta || '');
          await taskEvent(task, event.method || 'agent_event', { summary: String(delta || event.method || '').slice(0, 1000) });
        });
        client.close();
      } else {
        const client = createClaudeClient({ cwd: sandbox.path, timeoutMs: task.spec?.timeoutMs });
        activeAgentRuns.set(task.id, client);
        await client.run(text, async event => {
          const summary = event.type === 'assistant'
            ? event.message?.content?.filter(item => item.type === 'text').map(item => item.text).join('')
            : event.type === 'result' ? event.result : event.type;
          if (event.type === 'result') output += String(event.result || '');
          await taskEvent(task, event.type || 'agent_event', { summary: String(summary || '').slice(0, 1000) });
        });
        client.close();
      }
      if (task.status !== 'cancelled') {
        const diff = await readTaskDiff(sandbox);
        if (diff) await taskEvent(task, 'sandbox_diff', { diff });
        await recordTaskEvidence(task, 'agent_output', output || '执行端已完成任务。');
        if (diff) await recordTaskEvidence(task, 'sandbox_diff', diff);
        await agentTasks.recordResult(task, { summary: output || '执行端已完成任务。', evidence: [...(output ? ['agent_output'] : []), ...(diff ? ['sandbox_diff'] : [])] });
        await agentTasks.transition(task, 'verifying', '执行器已返回，等待独立验证。');
        workflowHooks.trigger?.(task);
      }
    } catch (error) {
      if (task.status === 'cancelled') await taskEvent(task, 'runner_closed', { code: 'TASK_CANCELLED' });
      else await agentTasks.fail(task, error);
      await taskEvent(task, 'error', { code: error.code || 'AGENT_TASK_FAILED' });
    } finally {
      activeAgentRuns.delete(task.id);
      if (sandbox && ['failed', 'cancelled'].includes(task.status)) await removeTaskSandbox(sandbox);
    }
  };
  const taskScheduler = createAgentScheduler({
    maxConcurrent: Number(process.env.AGENT_CONCURRENCY_MAX) || 3,
    getTask: id => state.agentTasks.find(item => item.id === id),
    runTask: runAgentTask,
    failTask: (task, reason) => agentTasks.transition(task, 'failed', reason)
  });
  for (const task of state.agentTasks.filter(item => item.status === 'submitted')) taskScheduler.enqueue(task);
  return { runAgentTask, taskScheduler };
}
