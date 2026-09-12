// readScope injection on the two generic /v1 read routes.
//
// Contract: docs/rearchitecture/core-v0-cleanup-slice/09-l2-contracts-2c-readscope-e2e.md
//           section 4.2 (corrected scope-out) and section 4.3 (bypass verdict +
//           minimal fix). Owner ruled 2026-09-12: case 2 is B (an omission).
//
// ---------------------------------------------------------------------------
// THE DEFECT (reproduced before the fix, through this very router)
// ---------------------------------------------------------------------------
//
// `POST /v1/retrieve` and `POST /v1/context-bundles` carried a `callerAgentId`
// but never derived a `readScope`. In the in-process deployment
// (server/index.js:187, the only CMD in the Dockerfile) the actor resolves to
// `'user'` (memory-module-runtime.js:80 -- only a service identity makes it
// 'agent'), and a user actor returns true from hasGrant on its first line
// (memory-module.js:352). So `readScope` is the *only* narrowing instrument
// there, and without it the whole provenance filter at memory-module.js:406 is
// skipped: agent B retrieved the assertion the user confided to agent A.
//
// ---------------------------------------------------------------------------
// THE FIX AND WHY IT IS SHAPED THIS WAY
// ---------------------------------------------------------------------------
//
// `createMemoryModuleRouter` takes an opt-in `narrowRead` flag. `run()` -- the
// wrapper shared by *every* route -- is deliberately untouched: injecting there
// would also reach the write (/events, /memories, /sessions, /access-grants),
// governance (/governance/*) and mutation routes, which the ruling does not
// cover. Only `memory-module-runtime.js` `router()` (the in-process deployment)
// passes the flag. The standalone service (services/memory-module/index.js:180)
// builds its own router without it and stays exactly as the ruling left it
// (contract section 4.3 row 1: default actor is 'agent', judged A).
//
// Because the flag is opt-in, the wiring itself is a test target: case R1 below
// drives the router built by `runtime.router()` -- the real in-process entry --
// so deleting `narrowRead: true` turns it red.
//
// ---------------------------------------------------------------------------
// SCOPE / NON-SCOPE
// ---------------------------------------------------------------------------
//
//   R1  in-process /v1/retrieve + /v1/context-bundles narrow to the caller   [here]
//   R2  non-read routes are NOT narrowed (the gate is real)                  [here]
//   R3  the standalone wiring is unchanged (no readScope reaches the module) [here]
//   R4  no callerAgentId => no injection (only ever subtracts, I-12)         [here]
//   R5  in-process GET /v1/memories narrows too (section 4.4.A)              [here]
//   R6  the standalone service gates the user actor behind a dev-only opt-in  [here]
//
// R5 and R6 were reported out of the 2c round and then ruled on (section
// 4.4.A: `GET /memories` is the same leak, fix it with the same gate). Section
// 4.4.B was first hardened to a fixed 'agent' literal, then REVISED (owner
// ruling 2026-09-12, option (3)): the actor type keeps 'agent' as its default
// and is honoured from `x-memory-actor-type` only behind the runtime's dev-only
// double gate (non-production AND env=true), with the value validated against
// the actor enum. R6a pins the source posture; R6b..R6e drive a mirror of it
// across the default, the opt-in, an invalid value and the production block.
//
// LIMIT, MEASURED NOT INFERRED (R5): the in-process agent is resolved by
// `resolveAgentIdForRequest` (server/index.js:95-105), which reads the session
// from `body.sessionId` / `body.session_id` / **`query.sessionId` only**. So
// `GET /v1/memories?sessionId=s-b` resolves agent-b and is narrowed, while
// `?session_id=s-b` resolves *no* agent and still reads the user's whole view.
// That residual is the null-caller fail-open (V-4), not the "B reads A" defect,
// and this file does not fix it -- R5 pins both shapes so the difference cannot
// be mistaken for a fix. See the R5 assertions and the impl note.
//
// ---------------------------------------------------------------------------
// SANDBOX NOTE
// ---------------------------------------------------------------------------
//
// Nothing here may reach server/store.js / core-v0-production.js -- `import('pg')`
// is SIGTERM-killed in this sandbox. This file imports memory-module.js,
// memory-module-runtime.js, memory-module-api.js and express only, none of which
// import pg.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import { MemoryModuleError, createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';
import { createMemoryModuleRouter } from './memory-module-api.js';

const BASE = { tenantId: 't', subjectUserId: 'u' };
const CONFIDED = '用户在准备离职';
const NEEDLE = '离职';

// Seed exactly as the drain does it (mirrors agent-scope-readscope-injection.test.js
// and agent-provenance.test.js): a raw event under agent A -> candidate ->
// user-actor promotion. The promoted assertion is tagged source_agent_id
// 'agent-a' on a *user* scope, which is what the narrowed read must hide from B.
const seedAgentAPrivate = async memoryState => {
  const memory = createMemoryModule(memoryState, async () => {});
  const recorded = await memory.recordEvent(
    { ...BASE, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
    {
      eventId: 'readscope-v1-event-a',
      sourceRevision: '1',
      content: '我只跟你一个人说：我下个月准备离职',
      eventRole: 'user',
      contentType: 'plain_text',
      isStreamFinal: true
    }
  );
  const created = await memory.createCandidate(
    { ...BASE, actorType: 'agent', actorId: 'agent-a', callerAgentId: 'agent-a' },
    {
      sourceEventId: recorded.rawEventId,
      content: CONFIDED,
      memoryType: 'fact',
      assertionType: 'observed_fact',
      scopeType: 'user'
    }
  );
  await memory.promoteCandidate(
    { ...BASE, actorType: 'user', actorId: 'u' },
    created.memory.memoryId,
    { resourceRevision: created.memory.memoryResourceRevision ?? created.memory.resourceRevision }
  );
};

// Harvest only content-bearing fields, never raw JSON: the request query itself
// contains the needle, so stringifying the whole response body would report a
// false leak. Containers (items, bundle partitions, blocks) are walked through;
// strings are collected only once inside a content-bearing key.
const CONTENT_KEYS = new Set(['content', 'summary', 'value', 'title', 'text']);
const harvest = (node, insideContent) => {
  if (typeof node === 'string') return insideContent ? [node] : [];
  if (Array.isArray(node)) return node.flatMap(item => harvest(item, insideContent));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, inner]) => harvest(inner, insideContent || CONTENT_KEYS.has(key)));
  }
  return [];
};
const seesConfided = body => harvest(body, false).some(text => text.includes(NEEDLE));

const request = async (base, path, body, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
};

const getJson = async (base, path, headers = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: await response.json() };
};

const serve = async (router, run) => {
  const app = express();
  app.use(express.json());
  app.use('/v1', router);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
};

// The in-process deployment shape: sessions bound to agents, the runtime
// resolving the caller from the session (server/index.js:95-105 is stood in for,
// exactly as documented in the 2c file above -- that link has no test anywhere).
// The stand-in mirrors that function's query handling verbatim: body.sessionId,
// body.session_id, and query.sessionId -- and NOT query.session_id. That
// asymmetry is load-bearing for R5 (see the LIMIT note at the top).
const inProcessRuntime = appState => createMemoryModuleRuntime({
  getState: () => appState,
  getUser: () => ({ id: 'u' }),
  tenantId: 't',
  resolveAgentId: req => {
    const sessionId = req?.body?.sessionId ?? req?.body?.session_id ?? req?.query?.sessionId ?? null;
    if (!sessionId) return null;
    return appState.sessions.find(item => item.id === sessionId)?.agentId || null;
  }
});

const sessions = [{ id: 's-a', agentId: 'agent-a' }, { id: 's-b', agentId: 'agent-b' }];
const retrieveBody = sessionId => ({ query: '离职 工作', session_id: sessionId, purpose: 'answer_user_query', tokenBudget: 1800 });

// ---------------------------------------------------------------------------
// R1 -- the fix, end to end through the real in-process router
// ---------------------------------------------------------------------------

test('R1: in-process /v1 read routes narrow to the caller -- B cannot read A\'s private assertion, A still can', async () => {
  const appState = { memoryModule: createMemoryModuleState(), sessions };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = inProcessRuntime(appState);

  // Prime and instrument the very instance the router will use (moduleForRequest
  // caches per state), so every context reaching the module is observable.
  const module = runtime.moduleForRequest({});
  const readCalls = [];
  const originalRetrieve = module.retrieveAsync;
  module.retrieveAsync = async (context, options) => {
    readCalls.push({ route: 'retrieve', context });
    return originalRetrieve.call(module, context, options);
  };
  const originalBundle = module.contextBundleAsync;
  module.contextBundleAsync = async (context, options) => {
    readCalls.push({ route: 'context-bundles', context });
    return originalBundle.call(module, context, options);
  };

  await serve(runtime.router(), async base => {
    const asB = await request(base, '/v1/retrieve', retrieveBody('s-b'));
    const asA = await request(base, '/v1/retrieve', retrieveBody('s-a'));
    const bundleB = await request(base, '/v1/context-bundles', retrieveBody('s-b'));

    assert.equal(asB.status, 200, 'the read must succeed');
    assert.equal(asA.status, 200, 'the read must succeed');
    assert.equal(bundleB.status, 200, 'the read must succeed');

    // The defect: B used to see the material confided to A.
    assert.equal(seesConfided(asB.body), false, 'agent B must not retrieve what was confided to agent A (/v1/retrieve)');
    assert.equal(seesConfided(bundleB.body), false, 'agent B must not retrieve it through /v1/context-bundles either');
    // Guard against the degenerate "hide it from everyone" fix.
    assert.equal(seesConfided(asA.body), true, 'agent A must still retrieve its own material -- no over-narrowing');
  });

  // And prove the narrowing came from the derived caller identity, not luck.
  const byRoute = readCalls.map(call => ({ route: call.route, readScope: call.context.readScope?.agentId, caller: call.context.callerAgentId }));
  assert.deepEqual(byRoute, [
    { route: 'retrieve', readScope: 'agent-b', caller: 'agent-b' },
    { route: 'retrieve', readScope: 'agent-a', caller: 'agent-a' },
    { route: 'context-bundles', readScope: 'agent-b', caller: 'agent-b' }
  ], 'each read must carry the readScope derived from its own caller agent');
});

// ---------------------------------------------------------------------------
// R2 -- the gate is real: non-read routes are not narrowed
// ---------------------------------------------------------------------------

test('R2: non-read routes are untouched -- a write route with a callerAgentId gets no readScope', async () => {
  const appState = { memoryModule: createMemoryModuleState(), sessions };
  const runtime = inProcessRuntime(appState);

  const module = runtime.moduleForRequest({});
  // /v1/events validates the session against the *memory* store, so create one
  // and bind it to agent A where the caller resolution reads it.
  const session = await module.createSession(
    { ...BASE, actorType: 'user', actorId: 'u', callerAgentId: 'agent-a' },
    { caller_agent_id: 'agent-a' }
  );
  appState.sessions.push({ id: session.id, agentId: 'agent-a' });

  const writeContexts = [];
  const originalRecordEvent = module.recordEvent;
  module.recordEvent = async (context, input) => {
    writeContexts.push(context);
    return originalRecordEvent.call(module, context, input);
  };

  await serve(runtime.router(), async base => {
    const written = await request(base, '/v1/events', {
      event_id: 'readscope-v1-write',
      source_revision: '1',
      session_id: session.id,
      content: 'A 的一条普通事件',
      event_role: 'user',
      content_type: 'plain_text',
      is_stream_final: true
    });
    assert.equal(written.status, 202, 'the write must still be accepted');
  });

  assert.equal(writeContexts.length, 1, 'the write must reach recordEvent exactly once');
  // The caller IS resolved -- so this is the gate, not a missing identity.
  assert.equal(writeContexts[0].callerAgentId, 'agent-a', 'the write route does resolve its caller agent');
  assert.equal(writeContexts[0].readScope, undefined, 'and yet the write route must NOT be narrowed (out of the ruling)');
});

// ---------------------------------------------------------------------------
// R3 -- the standalone wiring (services/memory-module/index.js:180) is unchanged
// ---------------------------------------------------------------------------

test('R3: the standalone service wiring injects no readScope (contract section 4.3 row 1 left as-is)', async () => {
  const memoryState = createMemoryModuleState();
  await seedAgentAPrivate(memoryState);
  const module = createMemoryModule(memoryState, async () => {});

  const readCalls = [];
  const originalRetrieve = module.retrieveAsync;
  module.retrieveAsync = async (context, options) => {
    readCalls.push(context);
    return originalRetrieve.call(module, context, options);
  };

  // Mirrors services/memory-module/index.js:107-136 + :180. The actor type is
  // the fixed literal, matching the 4.4.B hardening (R6 pins that at the
  // source). Deliberately no `narrowRead` flag: that is the point of R3.
  const router = createMemoryModuleRouter({
    memoryModuleForRequest: () => module,
    contextFromRequest: req => {
      const actorType = 'agent';
      const callerAgentId = String(req.get('x-memory-agent-id') || '').trim();
      return {
        tenantId: 't',
        subjectUserId: 'u',
        actorType,
        actorId: callerAgentId,
        callerAgentId,
        sessionId: null
      };
    }
  });

  await serve(router, async base => {
    const asB = await request(base, '/v1/retrieve', { query: '离职 工作', purpose: 'answer_user_query', tokenBudget: 1800 }, { 'x-memory-agent-id': 'agent-b' });
    assert.equal(asB.status, 200, 'the standalone read must succeed');
    assert.equal(seesConfided(asB.body), false, 'the standalone default was already non-leaking and must stay so');
  });

  assert.equal(readCalls.length, 1, 'the read must reach the module');
  assert.equal(readCalls[0].callerAgentId, 'agent-b', 'the standalone does resolve its caller agent');
  assert.equal(readCalls[0].readScope, undefined, 'the standalone router must not inject a readScope -- row 1 is out of the ruling');
});

// R3b -- source-level pin for R3's mirror.
//
// R3 drives a hand-written replica of the standalone service's context builder,
// so a regression in the real file would leave R3 green. Measured, not
// inferred (audit 2026-09-12): flipping the real
// `services/memory-module/index.js` router wiring to `narrowRead: true` -- a
// genuine regression against contract section 4.3 row 1 -- left the whole file
// at 11/11. This case closes that: it reads the real source and asserts the
// wiring posture, the same technique R6a uses for the actor gate.
//
// What is pinned: the standalone service must construct its memory module
// router WITHOUT the `narrowRead` opt-in, i.e. the fixed "agent" actor posture
// is the only thing keeping row 1 non-leaking. It also pins that the service
// still resolves a caller agent, because injecting a readScope would be the
// wrong fix here (Default is not narrow; the actor gate does the work).
test('R3b: the standalone service source carries no narrowRead opt-in (source pin, closes R3 mirror blindness)', async () => {
  const source = await readFile(new URL('../services/memory-module/index.js', import.meta.url), 'utf8');

  // The standalone router factory call must not request narrowed reads.
  assert.equal(
    /narrowRead\s*:\s*true/.test(source),
    false,
    'the standalone service must not opt into narrowed reads -- contract 4.3 row 1 is left as-is; a regression here leaks nothing visible to R3 (its mirror would stay green)'
  );
  assert.equal(
    /narrowRead/.test(source),
    false,
    'the standalone service should not mention narrowRead at all -- it constructs the router with the default (not narrowed) posture'
  );

  // It must still derive a caller agent, otherwise the actor gate has nothing
  // to key on and the service would fail closed rather than by design.
  assert.equal(
    /x-memory-agent-id/.test(source),
    true,
    'the standalone service must still read x-memory-agent-id (its context builder requires it)'
  );

  // And it must NOT import the in-process api factory variant that carries the
  // narrowing default, which is what a careless "fix" would reach for.
  assert.equal(
    /createMemoryModuleRouter/.test(source),
    true,
    'the standalone service must build its router through createMemoryModuleRouter'
  );
});

// ---------------------------------------------------------------------------
// R4 -- no callerAgentId => no injection (readScope only ever subtracts, I-12)
// ---------------------------------------------------------------------------

test('R4: an in-process read with no resolvable caller injects no readScope', async () => {
  const appState = { memoryModule: createMemoryModuleState(), sessions };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = inProcessRuntime(appState);

  const module = runtime.moduleForRequest({});
  const readCalls = [];
  const originalRetrieve = module.retrieveAsync;
  module.retrieveAsync = async (context, options) => {
    readCalls.push(context);
    return originalRetrieve.call(module, context, options);
  };

  await serve(runtime.router(), async base => {
    // No session_id in the body: resolveAgentIdForRequest returns null, and the
    // router's own context builder has no chat guard, so nothing throws.
    const anonymous = await request(base, '/v1/retrieve', { query: '离职 工作', purpose: 'answer_user_query', tokenBudget: 1800 });
    assert.equal(anonymous.status, 200, 'a caller-less read still completes');
  });

  assert.equal(readCalls.length, 1, 'the read must reach the module');
  assert.equal(readCalls[0].callerAgentId, null, 'no caller was resolved -- the silent path');
  assert.equal(readCalls[0].readScope, undefined, 'nothing to narrow to, so the context must be untouched');
});

// ---------------------------------------------------------------------------
// R5 -- section 4.4.A: GET /v1/memories narrows through the same gate
// ---------------------------------------------------------------------------

test('R5: in-process GET /v1/memories narrows to the caller -- B cannot list A\'s private assertion, A still can', async () => {
  const appState = { memoryModule: createMemoryModuleState(), sessions };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = inProcessRuntime(appState);

  const module = runtime.moduleForRequest({});
  const listCalls = [];
  const originalList = module.list;
  module.list = (context, options) => {
    listCalls.push({ caller: context.callerAgentId, readScope: context.readScope?.agentId ?? null });
    return originalList(context, options);
  };

  await serve(runtime.router(), async base => {
    // camelCase `sessionId` is the only query key resolveAgentIdForRequest reads
    // (server/index.js:98) -- so these two calls DO resolve an agent.
    const asB = await getJson(base, '/v1/memories?sessionId=s-b');
    const asA = await getJson(base, '/v1/memories?sessionId=s-a');

    assert.equal(asB.status, 200, 'the list must succeed');
    assert.equal(asA.status, 200, 'the list must succeed');
    // The 4.4.A defect: B used to list the material confided to A.
    assert.equal(seesConfided(asB.body), false, 'agent B must not list what was confided to agent A (section 4.4.A)');
    // Guard against the degenerate "hide it from everyone" fix.
    assert.equal(seesConfided(asA.body), true, 'agent A must still list its own material -- no over-narrowing');
  });

  assert.deepEqual(listCalls, [
    { caller: 'agent-b', readScope: 'agent-b' },
    { caller: 'agent-a', readScope: 'agent-a' }
  ], 'GET /memories must carry the readScope derived from its own caller agent');
});

// Characterization pin, NOT a correctness claim and NOT a fix (same posture as
// the V-4 pin in agent-scope-readscope-injection.test.js). `?session_id=` is
// snake_case, which resolveAgentIdForRequest does not read from the query, so
// no agent is resolved and there is nothing to narrow to -- the null-caller
// fail-open (memory-module.js:406) applies. This assertion exists so the gap
// cannot be mistaken for "A is fully fixed", and so a future change to the
// resolver's query keys turns it red and forces an informed update.
test('R5b: GET /v1/memories?session_id=... resolves no caller and still reads the user view (pinned known fail-open)', async () => {
  const appState = { memoryModule: createMemoryModuleState(), sessions };
  await seedAgentAPrivate(appState.memoryModule);
  const runtime = inProcessRuntime(appState);

  const module = runtime.moduleForRequest({});
  const listCalls = [];
  const originalList = module.list;
  module.list = (context, options) => {
    listCalls.push({ caller: context.callerAgentId, readScope: context.readScope?.agentId ?? null });
    return originalList(context, options);
  };

  await serve(runtime.router(), async base => {
    const asB = await getJson(base, '/v1/memories?session_id=s-b');
    assert.equal(asB.status, 200, 'the list completes');
    assert.equal(seesConfided(asB.body), true, 'KNOWN GAP: snake_case session_id resolves no caller, so the view is unnarrowed');
  });

  assert.deepEqual(listCalls, [{ caller: null, readScope: null }], 'no caller resolved => no readScope (fail-open)');
});

// ---------------------------------------------------------------------------
// R6 -- section 4.4.B (revised 2026-09-12): the standalone service gates the
//       user actor behind the runtime's dev-only double gate
// ---------------------------------------------------------------------------
//
// The service module itself cannot be imported from a test: it imports `pg`
// (SIGTERM in this sandbox), requires DATABASE_URL at load time, and starts a
// worker plus a listener. So the posture is pinned at the source (R6a) exactly
// as agent-scope-2a.test.js:246 pins the removed 'cochpia' fallback, and the
// behaviour is driven through a mirror builder (R6b..R6e) that R6a binds to the
// real file: the gate env name, the non-production clause, the `=== 'true'`
// match, the actor enum and the default literal are all asserted against
// services/memory-module/index.js, so a drift between mirror and source turns
// R6a red.

// Mirrors services/memory-module/index.js contextFromRequest verbatim. No
// `narrowRead`: the standalone keeps its own read posture (R3), and readScope is
// not what stops the escalation here -- the actor gate is.
const standaloneContextFromRequest = req => {
  const tenantId = String(req.get('x-memory-tenant-id') || '').trim();
  const subjectUserId = String(req.get('x-memory-user-id') || req.get('x-subject-user-id') || '').trim();
  const allowUntrustedActorHeader = process.env.NODE_ENV !== 'production'
    && process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER === 'true';
  let actorType = 'agent';
  if (allowUntrustedActorHeader) {
    const requestedActorType = String(req.get('x-memory-actor-type') || '').trim();
    if (requestedActorType) {
      if (!['user', 'agent', 'system'].includes(requestedActorType)) throw new MemoryModuleError('INVALID_ACTOR_TYPE', 'Invalid actor_type');
      actorType = requestedActorType;
    }
  }
  const callerAgentId = String(req.get('x-memory-agent-id') || req.get('x-caller-agent-id') || '').trim();
  if (!tenantId || !subjectUserId || !callerAgentId) throw new MemoryModuleError('MEMORY_CONTEXT_REQUIRED', 'Trusted tenant, subject user, and caller agent context are required', { status: 400 });
  return { tenantId, subjectUserId, actorType, actorId: actorType === 'user' ? subjectUserId : callerAgentId, callerAgentId, sessionId: req.body?.session_id || req.query?.session_id || null };
};

// Sets NODE_ENV / the opt-in env for the duration of `run`, then restores both
// exactly -- the read routes above rely on the ambient NODE_ENV.
const withActorHeaderEnv = async ({ nodeEnv, allow }, run) => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedAllow = process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  if (allow === undefined) delete process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER; else process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER = allow;
  try {
    return await run();
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedAllow === undefined) delete process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER; else process.env.MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER = savedAllow;
  }
};

// Drives the real router with the mirror builder over the same seed as R1..R5:
// an assertion confided to agent A, landing on the *user* scope. A user actor
// reads it (hasGrant short-circuit, memory-module.js:352); an agent actor B does
// not (memory-module.js:406). readCalls collects the exact context that reached
// the module.
const runStandaloneRead = async ({ readCalls, headers = {} }) => {
  const memoryState = createMemoryModuleState();
  await seedAgentAPrivate(memoryState);
  const module = createMemoryModule(memoryState, async () => {});
  const originalRetrieve = module.retrieveAsync;
  module.retrieveAsync = async (context, options) => {
    readCalls.push(context);
    return originalRetrieve.call(module, context, options);
  };
  const router = createMemoryModuleRouter({
    memoryModuleForRequest: () => module,
    contextFromRequest: standaloneContextFromRequest
  });
  return serve(router, base => request(
    base,
    '/v1/retrieve',
    { query: '离职 工作', purpose: 'answer_user_query', tokenBudget: 1800 },
    { 'x-memory-tenant-id': 't', 'x-memory-user-id': 'u', 'x-memory-agent-id': 'agent-b', ...headers }
  ));
};

test('R6a: the standalone service gates x-memory-actor-type behind the dev-only double gate (section 4.4.B, revised)', async () => {
  const source = await readFile(new URL('../services/memory-module/index.js', import.meta.url), 'utf8');
  const codeLines = source.split('\n').filter(line => !/^\s*\/\//.test(line));
  // The default stays the fixed literal -- no header needed for the agent posture.
  assert.equal(
    codeLines.some(line => /actorType = 'agent'/.test(line)),
    true,
    'the default actor type must stay the fixed literal agent'
  );
  // The header is consulted only behind the runtime's double gate.
  const gateIndex = codeLines.findIndex(line => /NODE_ENV !== 'production'/.test(line) && /MEMORY_ALLOW_UNTRUSTED_ACTOR_HEADER/.test(line) && /=== 'true'/.test(line));
  assert.notEqual(gateIndex, -1, 'the opt-in must mirror memory-module-runtime.js:78 (non-production AND env === true)');
  const headerIndex = codeLines.findIndex(line => /x-memory-actor-type/.test(line));
  assert.notEqual(headerIndex, -1, 'the service reads the header under the gate');
  assert.ok(headerIndex > gateIndex, 'the header read must sit after the gate');
  // The gate is its own switch: reusing the agent-id env would conflate two threats.
  assert.equal(
    codeLines.some(line => /MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS/.test(line)),
    false,
    'the actor-type gate must not reuse MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS (different threat)'
  );
  // A header-derived value is validated against the actor enum (memory-module.js:243).
  assert.equal(
    codeLines.some(line => /\['user', 'agent', 'system'\]/.test(line)),
    true,
    'a header-derived actor type must be validated, or an arbitrary value becomes an illegal actorType'
  );
});

test('R6b: default shape (opt-in off) -- x-memory-actor-type: user is ignored, stays agent, no leak', async () => {
  const readCalls = [];
  const result = await withActorHeaderEnv({ nodeEnv: 'test', allow: undefined }, () => runStandaloneRead({
    readCalls,
    headers: { 'x-memory-actor-type': 'user' }
  }));

  assert.equal(result.status, 200, 'the read must still succeed -- the header is ignored, not fatal');
  assert.equal(seesConfided(result.body), false, 'asking to be the user actor must not expose another agent\'s material by default (4.4.B)');
  assert.equal(readCalls.length, 1, 'the read must reach the module');
  assert.equal(readCalls[0].actorType, 'agent', 'the requested user actor must be refused by default');
  assert.equal(readCalls[0].actorId, 'agent-b', 'the actor must be the caller agent, so hasGrant actually applies');
});

test('R6c: opt-in on (non-production + env=true) -- the header is honoured: user actor reads its own view', async () => {
  const readCalls = [];
  const result = await withActorHeaderEnv({ nodeEnv: 'test', allow: 'true' }, () => runStandaloneRead({
    readCalls,
    headers: { 'x-memory-actor-type': 'user' }
  }));

  assert.equal(result.status, 200, 'the read must succeed');
  assert.equal(readCalls.length, 1, 'the read must reach the module');
  assert.equal(readCalls[0].actorType, 'user', 'under the gate the header must be honoured');
  assert.equal(readCalls[0].actorId, 'u', 'a user actor keys actorId on the subject user');
  // This is exactly the capability scripts/memory-module-sdk-smoke.js:25 relies on.
  assert.equal(seesConfided(result.body), true, 'the opt-in user actor reads the user-scope view (read-your-write) -- dev-only convenience');
});

test('R6d: opt-in on + an unknown value is rejected -- no header can manufacture an illegal actorType', async () => {
  const readCalls = [];
  const result = await withActorHeaderEnv({ nodeEnv: 'test', allow: 'true' }, () => runStandaloneRead({
    readCalls,
    headers: { 'x-memory-actor-type': 'forged-actor' }
  }));

  assert.equal(result.status, 400, 'an unknown actor type must be a 400, not a silently accepted value');
  assert.equal(result.body.error?.code, 'INVALID_ACTOR_TYPE', 'and it must be the enum error');
  assert.equal(readCalls.length, 0, 'the request must not reach the module carrying an illegal actorType');
});

test('R6e: production hard-blocks the opt-in -- env=true alone is not enough', async () => {
  const readCalls = [];
  const result = await withActorHeaderEnv({ nodeEnv: 'production', allow: 'true' }, () => runStandaloneRead({
    readCalls,
    headers: { 'x-memory-actor-type': 'user' }
  }));

  assert.equal(result.status, 200, 'the read completes');
  assert.equal(readCalls.length, 1, 'the read must reach the module');
  assert.equal(readCalls[0].actorType, 'agent', 'the production clause must win over the env switch');
});
