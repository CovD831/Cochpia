import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRealMemoryEvaluationInput } from '../server/memory-module-eval.js';
import { assessEvidenceEnvelope, assessFullCanonical1MArtifact, gateResult, isAlphaGateReady } from '../server/companion-alpha-gate.js';

const root = process.cwd();
const artifact = name => path.join(root, 'artifacts', name);

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function evaluateRealCases() {
  const casesPath = process.env.MEMORY_EVAL_CASES ? path.resolve(root, process.env.MEMORY_EVAL_CASES) : null;
  const resultsPath = process.env.MEMORY_EVAL_RESULTS ? path.resolve(root, process.env.MEMORY_EVAL_RESULTS) : null;
  if (!casesPath || !resultsPath) return gateResult('missing', 'MEMORY_EVAL_CASES and MEMORY_EVAL_RESULTS are required');
  try {
    const validated = validateRealMemoryEvaluationInput({
      casesPayload: await readJson(casesPath),
      resultsPayload: await readJson(resultsPath),
      split: process.env.MEMORY_EVAL_SPLIT || 'all'
    });
    return gateResult('passed', 'complete real/deidentified evaluation envelope validated', [
      `datasetKind=${validated.datasetKind}`,
      `version=${validated.version}`,
      `caseCount=${validated.cases.length}`
    ]);
  } catch (error) {
    return gateResult('failed', error.code || 'MEMORY_EVAL_INPUT_INVALID');
  }
}

async function evaluateFullCanonical1M() {
  const filePath = process.env.MEMORY_MODULE_FULL_1M_ARTIFACT
    ? path.resolve(root, process.env.MEMORY_MODULE_FULL_1M_ARTIFACT)
    : null;
  if (!filePath || !(await exists(filePath))) return gateResult('missing', 'A full canonical 1M pgvector/HNSW artifact is required');
  try {
    const report = await readJson(filePath);
    return assessFullCanonical1MArtifact(report, [path.relative(root, filePath)]);
  } catch {
    return gateResult('failed', 'full canonical 1M artifact is not valid JSON');
  }
}

async function evaluateEvidenceFile(envName, requiredKeys, reason) {
  const filePath = process.env[envName] ? path.resolve(root, process.env[envName]) : null;
  if (!filePath || !(await exists(filePath))) return gateResult('missing', reason);
  try {
    const report = await readJson(filePath);
    return assessEvidenceEnvelope(report, requiredKeys, [path.relative(root, filePath)]);
  } catch {
    return gateResult('failed', `${envName} does not point to a valid JSON evidence envelope`);
  }
}

const gates = {
  localEvidence: (await exists(artifact('companion-core-acceptance-rerun-2026-08-24.json'))
    && await exists(artifact('companion-core-outage-backlog-2026-08-24.json')))
    ? gateResult('passed', 'local acceptance artifacts are present')
    : gateResult('missing', 'local acceptance artifacts are incomplete'),
  realEvaluation: await evaluateRealCases(),
  fullCanonical1M: await evaluateFullCanonical1M(),
  hostedProduction: await evaluateEvidenceFile(
    'COMPANION_HOSTED_EVIDENCE_FILE',
    ['rpoRto', 'longOutage', 'deletePropagation', 'https', 'logs', 'cache', 'capacity', 'multiDevice'],
    'COMPANION_HOSTED_EVIDENCE_FILE is required for hosted production evidence'
  ),
  providerAudit: await evaluateEvidenceFile(
    'COMPANION_PROVIDER_AUDIT_FILE',
    ['retention', 'region', 'training', 'deletion', 'quality'],
    'COMPANION_PROVIDER_AUDIT_FILE is required for provider audit evidence'
  )
};

const ready = isAlphaGateReady(gates);
console.log(JSON.stringify({
  event: 'companion_core_alpha_gate_audit',
  ready,
  gates,
  note: ready ? 'All declared Alpha evidence gates passed' : 'Not ready: missing or failed evidence gates are reported without being inferred'
}));
if (!ready) process.exitCode = 2;
