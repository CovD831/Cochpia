import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';

const mode = String(process.env.AUTH_MODE || 'off').toLowerCase();
const apiToken = process.env.COCHPIA_API_TOKEN || '';
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const jwks = supabaseUrl ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`)) : null;

// Token mode (deployment posture for a personal instance): the loopback
// surface stays open for the local UI, everything off-box must present the
// shared COCHPIA_API_TOKEN. Multi-user auth (Supabase) remains available via
// AUTH_MODE=required when there is ever a second real user.
const isLoopback = req => {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};
const bearerOf = req => {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};
const sameSecret = (presented, expected) =>
  timingSafeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(expected).digest());

export async function authenticateRequest(req) {
  if (mode === 'off') return { id: 'local-user', email: null, local: true };
  if (mode === 'token') {
    if (isLoopback(req)) return { id: 'local-user', email: null, local: true };
    if (!apiToken) throw Object.assign(new Error('COCHPIA_API_TOKEN is required when AUTH_MODE=token'), { code: 'AUTH_CONFIGURATION_INVALID', status: 503 });
    const token = bearerOf(req);
    if (!token) throw Object.assign(new Error('Authentication is required'), { code: 'AUTH_REQUIRED', status: 401 });
    if (!sameSecret(token, apiToken)) throw Object.assign(new Error('Invalid access token'), { code: 'AUTH_INVALID', status: 401 });
    // One user, one identity: a valid token caller IS the owner, so data keeps
    // the same subjectUserId as local use.
    return { id: 'local-user', email: null, local: false };
  }
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw Object.assign(new Error('Authentication is required'), { code: 'AUTH_REQUIRED', status: 401 });
  if (!supabaseUrl) throw Object.assign(new Error('SUPABASE_URL is required when AUTH_MODE=required'), { code: 'AUTH_CONFIGURATION_INVALID', status: 503 });
  try {
    const key = process.env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET) : jwks;
    const { payload } = await jwtVerify(token, key, { issuer: `${supabaseUrl}/auth/v1`, audience: 'authenticated' });
    if (!payload.sub) throw new Error('Token subject is missing');
    return { id: payload.sub, email: payload.email || null, local: false };
  } catch (error) {
    throw Object.assign(new Error('Invalid or expired access token', { cause: error }), { code: 'AUTH_INVALID', status: 401 });
  }
}

export function authRequired() { return mode === 'required'; }
export function authMode() { return mode; }

export function validateAuthStorage(storageProvider) {
  if (mode === 'token' && !apiToken) {
    throw Object.assign(
      new Error('COCHPIA_API_TOKEN is required when AUTH_MODE=token'),
      { code: 'AUTH_CONFIGURATION_INVALID', status: 503 }
    );
  }
  if (mode !== 'required') return;
  if (String(storageProvider).toLowerCase() !== 'postgres') {
    throw Object.assign(
      new Error('STORAGE_PROVIDER=postgres is required when AUTH_MODE=required'),
      { code: 'AUTH_STORAGE_CONFIGURATION_INVALID', status: 503 }
    );
  }
}
