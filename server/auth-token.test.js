// AUTH_MODE=token: the loopback-free/remote-token deployment posture.
// mode is captured at module load, so each case re-imports with a cache-busting
// query string after setting the env it needs.
import test from 'node:test';
import assert from 'node:assert/strict';

const load = async env => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import(`../server/auth.js?case=${Math.random()}`);
};

const request = (remoteAddress, authorization) => ({
  socket: { remoteAddress },
  get: header => (header === 'authorization' ? authorization : null)
});

test('token mode: loopback callers keep the local identity without a token', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  const user = await auth.authenticateRequest(request('127.0.0.1', undefined));
  assert.equal(user.id, 'local-user');
  assert.equal(user.local, true);
});

test('token mode: off-box caller without a token is rejected with AUTH_REQUIRED', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  await assert.rejects(
    () => auth.authenticateRequest(request('172.20.10.5', undefined)),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401
  );
});

test('token mode: off-box caller with a wrong token is rejected with AUTH_INVALID', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  await assert.rejects(
    () => auth.authenticateRequest(request('172.20.10.5', 'Bearer wrong-token')),
    error => error.code === 'AUTH_INVALID' && error.status === 401
  );
});

test('token mode: off-box caller with the right token passes as the owner', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  const user = await auth.authenticateRequest(request('172.20.10.5', 'Bearer secret-token'));
  assert.equal(user.id, 'local-user');
  assert.equal(user.local, false);
});

test('token mode: ::ffff:127.0.0.1 mapped loopback stays open', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  const user = await auth.authenticateRequest(request('::ffff:127.0.0.1', undefined));
  assert.equal(user.local, true);
});

test('token mode: startup validation fails fast without COCHPIA_API_TOKEN', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: undefined });
  assert.throws(
    () => auth.validateAuthStorage('json'),
    error => error.code === 'AUTH_CONFIGURATION_INVALID'
  );
});

test('token mode: storage validation does not force postgres (unlike required mode)', async () => {
  const auth = await load({ AUTH_MODE: 'token', COCHPIA_API_TOKEN: 'secret-token' });
  assert.doesNotThrow(() => auth.validateAuthStorage('json'));
});

test('off mode: behavior unchanged', async () => {
  const auth = await load({ AUTH_MODE: 'off', COCHPIA_API_TOKEN: undefined });
  const user = await auth.authenticateRequest(request('172.20.10.5', undefined));
  assert.equal(user.local, true);
  assert.doesNotThrow(() => auth.validateAuthStorage('json'));
});
