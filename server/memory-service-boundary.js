import { timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const readOnlyPostPaths = new Set(['/retrieve', '/context-bundles']);

function safeTokenEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message, retryable: false, unknown: false } });
}

function bodyValue(req, ...keys) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  for (const key of keys) {
    const value = req.get(key) ?? body[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function isMemoryMutationRequest(req) {
  const method = String(req.method || '').toUpperCase();
  if (!mutationMethods.has(method)) return false;
  return !(method === 'POST' && readOnlyPostPaths.has(req.path));
}

export function createMemoryServiceBoundary({
  token = process.env.MEMORY_SERVICE_TOKEN || process.env.MEMORY_MODULE_SERVICE_TOKEN || '',
  serviceId = process.env.MEMORY_SERVICE_ID || 'companion-core',
  requiredProducer = 'companion-core',
  jwtSecret = process.env.MEMORY_SERVICE_JWT_SECRET || '',
  issuer = process.env.MEMORY_SERVICE_ISSUER || '',
  audience = process.env.MEMORY_SERVICE_AUDIENCE || '',
  production = process.env.NODE_ENV === 'production'
} = {}) {
  const verifyCredential = async suppliedToken => {
    if (jwtSecret) {
      if (!issuer || !audience) return null;
      try {
        const { payload } = await jwtVerify(suppliedToken, new TextEncoder().encode(jwtSecret), { issuer, audience });
        if (String(payload.sub || '') !== serviceId) return null;
        if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
        return {
          credentialType: 'jwt',
          serviceId: String(payload.sub || serviceId),
          subjectUserId: payload.subject_user_id || payload.subjectUserId || null,
          tenantId: payload.tenant_id || payload.tenantId || null
        };
      } catch {
        return null;
      }
    }
    if (production || !safeTokenEqual(suppliedToken, token)) return null;
    return { credentialType: 'development-token', serviceId, subjectUserId: null, tenantId: null };
  };

  const handle = async (req, res, next) => {
    if (!isMemoryMutationRequest(req)) return next();

    const authorization = req.get('authorization') || '';
    const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const verified = await verifyCredential(suppliedToken);
    if (!verified) {
      return sendError(res, 403, 'MEMORY_SERVICE_IDENTITY_REQUIRED', 'A verified Memory service identity is required');
    }

    const producer = bodyValue(req, 'x-memory-producer', 'producer');
    const correlationId = bodyValue(req, 'x-correlation-id', 'correlation_id', 'correlationId');
    const idempotencyKey = bodyValue(req, 'idempotency-key', 'idempotency_key', 'idempotencyKey');
    if (producer !== requiredProducer || !correlationId || !idempotencyKey) {
      return sendError(res, 400, 'MEMORY_WRITE_CONTEXT_REQUIRED', 'producer, correlation ID and idempotency key are required for Memory writes');
    }

    const subjectUserId = verified.subjectUserId || bodyValue(req, 'x-memory-subject-user-id', 'subject_user_id', 'subjectUserId') || null;
    req.memoryServiceIdentity = {
      credentialType: verified.credentialType,
      serviceId: verified.serviceId,
      producer,
      correlationId,
      idempotencyKey,
      subjectUserId,
      tenantId: verified.tenantId
    };
    return next();
  };

  return (req, res, next) => handle(req, res, next).catch(next);
}
