// Promotion TLS evidence, host side (machine A).
//
// Loads the same fixtures as the outer foundation script, seeds the acceptance
// app and serves it on a loopback port in host mode. A TLS front
// (scripts/core-v0-tls-front.mjs) terminates TLS in front of it; the acceptance
// client runs on the remote machine against that front. This process holds
// until SIGINT/SIGTERM and prints ACCEPTANCE_HOST_READY when serving.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCoreV0Acceptance } from './core-v0-runtime-acceptance.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'docs/rearchitecture/core-v0-foundation-slice/fixtures');

const legacy = JSON.parse(await readFile(path.join(fixtureDir, 'legacy-chat-turn.json'), 'utf8'));
const target = JSON.parse(await readFile(path.join(fixtureDir, 'target-chat-turn.json'), 'utf8'));

await runCoreV0Acceptance({ legacy, target });
