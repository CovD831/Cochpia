import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredCommands = ['initdb', 'pg_ctl', 'openssl'];

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { cwd: root, maxBuffer: 8 * 1024 * 1024, ...options });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const commandPaths = {};
for (const command of requiredCommands) {
  try { commandPaths[command] = (await run('which', [command])).stdout.trim().split('\n')[0]; } catch {
    console.log(JSON.stringify({ event: 'companion_core_tls_acceptance_skipped', reason: `${command}_not_available` }));
    process.exit(0);
  }
}

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'cochpia-pg-tls-'));
const dataDirectory = path.join(tempDirectory, 'data');
const caKey = path.join(tempDirectory, 'ca.key');
const caCert = path.join(tempDirectory, 'ca.crt');
const serverKey = path.join(tempDirectory, 'server.key');
const serverCsr = path.join(tempDirectory, 'server.csr');
const serverCert = path.join(tempDirectory, 'server.crt');
const serialFile = path.join(tempDirectory, 'ca.srl');
const extensionsFile = path.join(tempDirectory, 'server-ext.cnf');
const logFile = path.join(tempDirectory, 'postgres.log');
const port = await freePort();
let serverStarted = false;

try {
  await run(commandPaths.initdb, ['-D', dataDirectory, '--no-locale', '--encoding=UTF8', '--auth=trust']);
  await run(commandPaths.openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '2', '-subj', '/CN=Cochpia Acceptance CA']);
  await run(commandPaths.openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=localhost']);
  await writeFile(extensionsFile, '[v3_req]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', 'utf8');
  await run(commandPaths.openssl, ['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-CAserial', serialFile, '-out', serverCert, '-days', '2', '-sha256', '-extfile', extensionsFile, '-extensions', 'v3_req']);
  await chmod(serverKey, 0o600);
  await writeFile(path.join(dataDirectory, 'postgresql.conf'), `\nssl=on\nssl_cert_file='${serverCert}'\nssl_key_file='${serverKey}'\nssl_ca_file='${caCert}'\nlisten_addresses='127.0.0.1'\n`, { flag: 'a' });
  await writeFile(path.join(dataDirectory, 'pg_hba.conf'), '\nhostssl all all 127.0.0.1/32 trust\n', { flag: 'a' });
  await run(commandPaths.pg_ctl, ['-D', dataDirectory, '-o', `-p ${port}`, '-l', logFile, '-w', 'start']);
  serverStarted = true;

  const databaseUrl = `postgresql://127.0.0.1:${port}/postgres`;
  const ssl = resolveDbSsl();
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: { ...ssl, ca: await readFile(caCert) }, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    const result = await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
    assert.equal(result.rows[0]?.ssl, true, 'PostgreSQL connection must use TLS');
  } finally {
    await pool.end();
  }

  const acceptance = await run(process.execPath, ['scripts/companion-core-auth-acceptance.js'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_SSL: 'true',
      DATABASE_CA: caCert,
      COMPANION_CORE_AUTH_REQUIRE_TLS: 'true'
    }
  });
  assert.match(acceptance.stdout, /companion_core_auth_acceptance_passed/);
  console.log(JSON.stringify({ event: 'companion_core_tls_acceptance_passed', tlsVerified: true, certificateVerification: true, requiredAuthAcceptance: true, postgresPort: port }));
} catch (error) {
  console.error(JSON.stringify({ event: 'companion_core_tls_acceptance_failed', code: error.code || 'COMPANION_CORE_TLS_ACCEPTANCE_FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  if (serverStarted) await run(commandPaths.pg_ctl, ['-D', dataDirectory, '-w', 'stop', '-m', 'fast']).catch(() => {});
  await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
}
