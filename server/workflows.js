import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configs', 'workflows');
const clean = value => String(value ?? '').trim();
const asList = value => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];

export function validateWorkflowSpec(spec) {
  if (!spec || typeof spec !== 'object') throw Object.assign(new Error('Workflow spec must be an object'), { code: 'WORKFLOW_INVALID' });
  const id = clean(spec.id);
  if (!id) throw Object.assign(new Error('Workflow id is required'), { code: 'WORKFLOW_INVALID' });
  if (!Array.isArray(spec.stages) || !spec.stages.length) throw Object.assign(new Error('Workflow stages are required'), { code: 'WORKFLOW_INVALID' });
  const stageIds = new Set();
  for (const stage of spec.stages) {
    if (!stage || typeof stage !== 'object' || !clean(stage.id)) throw Object.assign(new Error('Workflow stage id is required'), { code: 'WORKFLOW_INVALID' });
    if (stageIds.has(clean(stage.id))) throw Object.assign(new Error(`Duplicate workflow stage: ${clean(stage.id)}`), { code: 'WORKFLOW_INVALID' });
    stageIds.add(clean(stage.id));
  }
  for (const stage of spec.stages) {
    for (const dependency of asList(stage.dependsOn)) {
      if (!stageIds.has(dependency)) throw Object.assign(new Error(`Unknown workflow dependency: ${dependency}`), { code: 'WORKFLOW_INVALID' });
    }
    for (const source of asList(Array.isArray(stage.inputFrom) ? stage.inputFrom : stage.inputFrom ? [stage.inputFrom] : [])) {
      if (!stageIds.has(source)) throw Object.assign(new Error(`Unknown workflow inputFrom stage: ${source}`), { code: 'WORKFLOW_INVALID' });
    }
  }
  return spec;
}

export function loadWorkflowSpec(workflowId) {
  const id = clean(workflowId);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw Object.assign(new Error('Invalid workflow id'), { code: 'WORKFLOW_NOT_FOUND' });
  const file = path.join(workflowDirectory, `${id}.json`);
  try {
    return validateWorkflowSpec(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'WORKFLOW_INVALID') throw error;
    throw Object.assign(new Error(`Workflow not found: ${id}`), { code: 'WORKFLOW_NOT_FOUND' });
  }
}

export function listWorkflows() {
  return fs.readdirSync(workflowDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => loadWorkflowSpec(entry.name.slice(0, -5)))
    .map(({ id, name, description, stages, checkpoints = [] }) => ({ id, name, description, stages, checkpoints }));
}
