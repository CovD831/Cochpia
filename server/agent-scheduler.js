export function createAgentScheduler({ getTask, runTask, failTask, maxConcurrent = 3 }) {
  const ready = [];
  const waiting = new Set();
  let running = 0;

  const dependencies = task => (task.dependsOn || []).map(getTask).filter(Boolean);
  const blocked = task => dependencies(task).some(dep => ['failed', 'cancelled'].includes(dep.status));
  const satisfied = task => (task.dependsOn || []).every(id => getTask(id)?.status === 'completed');

  const pump = async () => {
    while (running < Math.max(1, Number(maxConcurrent) || 3) && ready.length) {
      const task = ready.shift();
      if (task.status !== 'submitted') continue;
      running += 1;
      void Promise.resolve(runTask(task)).finally(() => { running -= 1; notify(task); void pump(); });
    }
  };

  const enqueue = task => {
    if (task.status !== 'submitted') return;
    if (blocked(task)) { void failTask(task, 'dependency_failed'); return; }
    if (satisfied(task)) ready.push(task);
    else waiting.add(task);
    void pump();
  };

  const notify = changedTask => {
    for (const task of [...waiting]) {
      if (blocked(task)) { waiting.delete(task); void failTask(task, 'dependency_failed'); }
      else if (satisfied(task)) { waiting.delete(task); ready.push(task); }
    }
    if (changedTask) {
      for (const task of ready) if (blocked(task)) { ready.splice(ready.indexOf(task), 1); void failTask(task, 'dependency_failed'); }
    }
    void pump();
  };

  return { enqueue, notify, pump, get running() { return running; } };
}
