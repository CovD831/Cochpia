import fs from 'node:fs';
import path from 'node:path';

// 数据库 TLS 配置(共享,避免多处重复并保持一致的安全语义)。
//   DATABASE_SSL=true            严格校验证书(推荐;公开 CA,或配合 DATABASE_CA 使用)
//   DATABASE_SSL=no-verify       仅加密、不校验证书(不推荐;仅自签名且无 CA 时显式使用)
//   DATABASE_CA=/path/to/ca.pem  自定义 CA 证书路径(可选,配合 DATABASE_SSL=true)
//   DATABASE_URL?sslmode=verify-full&sslrootcert=/path/to/ca.pem
//                                URL 形式,与上面等价(pg 自己会据此连接)
//
// 为什么需要 URL 回退:DATABASE_URL 也是 TLS 的一种声明形式。只读 DATABASE_SSL
// 会把「用 URL 配的严格 TLS」误判成未配置——2026-09-12 的 live 验收就是因此在
// strictTlsConfigured=false 上卡住 L-01,而实际连接一直是 verify-full。
// 语义严格对齐 pg 自身:只有 verify-full 承认严格;require/prefer 只加密、不校验证书,
// 一律不声称严格(既不放大也不弱化)。

function tlsPartsFromUrl() {
  const raw = String(process.env.DATABASE_URL || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return {
    mode: String(parsed.searchParams.get('sslmode') || '').toLowerCase(),
    rootCert: String(parsed.searchParams.get('sslrootcert') || '').trim()
  };
}

function readCa(candidate) {
  const file = String(candidate || '').trim();
  if (!file) return undefined;
  return fs.readFileSync(path.resolve(file));
}

function strictSslFromUrl() {
  const parts = tlsPartsFromUrl();
  if (!parts || parts.mode !== 'verify-full') return undefined;
  const ssl = { rejectUnauthorized: true };
  // sslrootcert 与 DATABASE_CA 语义相同,必须显式带上:只传 rejectUnauthorized
  // 而不带 CA,可能把 URL 解析出的自定义 CA 丢掉,自签 CA 的部署会直接连不上。
  const ca = readCa(parts.rootCert) || readCa(process.env.DATABASE_CA);
  if (ca) ssl.ca = ca;
  return ssl;
}

export function resolveDbSsl() {
  const mode = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (mode === 'true' || mode === 'require' || mode === 'verify-full') {
    const ssl = { rejectUnauthorized: true };
    if (process.env.DATABASE_CA) ssl.ca = fs.readFileSync(path.resolve(process.env.DATABASE_CA));
    return ssl;
  }
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode) return undefined;
  return strictSslFromUrl();
}
