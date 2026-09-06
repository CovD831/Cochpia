// A small relational test double for the R-003 SQL contract. It intentionally
// understands only the parameterized statements emitted by core-v0-postgres.js.

const tableNames = [
  'core_v0_subjects',
  'core_v0_turn_admissions',
  'core_v0_memory_session_bindings',
  'core_v0_assistant_commits',
  'core_v0_messages',
  'core_v0_admission_gates',
  'core_v0_admission_leases',
  'core_v0_repair_attempts',
  'core_v0_crash_records'
];

const emptyTables = () => Object.fromEntries(tableNames.map(name => [name, []]));
const clone = value => structuredClone(value);
const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();

function key(values) {
  return values.map(value => value == null ? '<null>' : String(value)).join('\u0000');
}

function uniqueKeys(table, row) {
  const rows = {
    core_v0_subjects: [['tenant_id', 'subject_user_id']],
    core_v0_turn_admissions: [
      ['tenant_id', 'turn_id'],
      ['tenant_id', 'subject_user_id', 'application_session_id', 'idempotency_key'],
      ['tenant_id', 'subject_user_id', 'application_session_id', 'source_revision'],
      ['tenant_id', 'subject_user_id', 'application_message_id'],
      ['tenant_id', 'subject_user_id', 'event_id']
    ],
    core_v0_memory_session_bindings: [
      ['tenant_id', 'binding_id'],
      ['tenant_id', 'subject_user_id', 'application_session_id'],
      ['tenant_id', 'subject_user_id', 'binding_key']
    ],
    core_v0_assistant_commits: [
      ['tenant_id', 'commit_id'],
      ['tenant_id', 'subject_user_id', 'assistant_message_id']
    ],
    core_v0_messages: [['tenant_id', 'application_message_id']],
    core_v0_admission_gates: [['gate_id']],
    core_v0_admission_leases: [['gate_id', 'lease_id']],
    core_v0_repair_attempts: [['repair_attempt_id']],
    core_v0_crash_records: [['crash_record_id']]
  }[table] || [];
  return rows.filter(fields => fields.every(field => row[field] != null)).map(fields => key(fields.map(field => row[field])));
}

function isDuplicate(tables, table, row) {
  const candidate = uniqueKeys(table, row);
  return tables[table].some(existing => uniqueKeys(table, existing).some(existingKey => candidate.includes(existingKey))
    || table === 'core_v0_admission_leases'
      && row.status === 'active'
      && existing.status === 'active'
      && existing.gate_id === row.gate_id
      && existing.admission_key === row.admission_key);
}

function duplicateError(table) {
  const error = new Error(`duplicate key in ${table}`);
  error.code = '23505';
  return error;
}

function tableFromInsert(sql) {
  const match = sql.match(/^INSERT INTO ([a-z0-9_]+) \(([^)]+)\) VALUES \(/i);
  if (!match) return null;
  return { table: match[1], columns: match[2].split(',').map(column => column.trim()) };
}

function resultForReturning(sql, row) {
  const match = sql.match(/RETURNING (.+)$/i);
  if (!match) return { rows: [], rowCount: 1 };
  const columns = match[1].split(',').map(column => column.trim());
  return { rows: [Object.fromEntries(columns.map(column => [column, row[column]]))], rowCount: 1 };
}

function selectRows(tables, sql, values) {
  const tableMatch = sql.match(/FROM ([a-z0-9_]+)/i);
  if (!tableMatch) return { rows: [] };
  const table = tableMatch[1];
  let rows = [...(tables[table] || [])];
  if (table === 'core_v0_subjects' && sql.includes('tenant_id=$1') && sql.includes('subject_user_id=$2')) rows = rows.filter(row => row.tenant_id === values[0] && row.subject_user_id === values[1]);
  if (table === 'core_v0_turn_admissions' || table === 'core_v0_memory_session_bindings' || table === 'core_v0_assistant_commits' || table === 'core_v0_messages') {
    rows = rows.filter(row => row.tenant_id === values[0] && row.subject_user_id === values[1]);
  }
  if (table === 'core_v0_admission_gates') rows = rows.filter(row => row.gate_id === values[0]);
  if (table === 'core_v0_admission_leases') {
    if (sql.includes('admission_key=$2')) rows = rows.filter(row => row.gate_id === values[0] && row.admission_key === values[1] && row.status === 'active');
    else rows = rows.filter(row => row.gate_id === values[0] && row.status === 'active');
  }
  if (table === 'core_v0_repair_attempts' && sql.includes('repair_attempt_id=$1')) rows = rows.filter(row => row.repair_attempt_id === values[0]);

  const selected = sql.match(/^SELECT (.+?) FROM/i)?.[1] || '*';
  if (selected !== '*') {
    const columns = selected.split(',').map(column => column.trim());
    rows = rows.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
  }
  return { rows };
}

function execute(tables, sql, values) {
  if (!sql || sql.startsWith('--') || sql.includes('CREATE TABLE') || sql.includes('CREATE UNIQUE INDEX')) return { rows: [] };
  if (/^BEGIN(?:\s+ISOLATION\s+LEVEL\s+[A-Z\s]+)?$/i.test(sql)
    || sql === 'COMMIT'
    || sql === 'ROLLBACK') return { rows: [] };
  if (/^SELECT /i.test(sql)) return selectRows(tables, sql, values);

  const insert = tableFromInsert(sql);
  if (insert) {
    const row = Object.fromEntries(insert.columns.map((column, index) => [column, values[index]]));
    const duplicate = isDuplicate(tables, insert.table, row);
    if (duplicate && /ON CONFLICT .*DO NOTHING/i.test(sql)) return { rows: [], rowCount: 0 };
    if (duplicate) throw duplicateError(insert.table);
    tables[insert.table].push(row);
    return resultForReturning(sql, row);
  }

  const deleteMatch = sql.match(/^DELETE FROM ([a-z0-9_]+) WHERE tenant_id=\$1 AND subject_user_id=\$2/i);
  if (deleteMatch) {
    const table = deleteMatch[1];
    const before = tables[table].length;
    tables[table] = tables[table].filter(row => row.tenant_id !== values[0] || row.subject_user_id !== values[1]);
    return { rows: [], rowCount: before - tables[table].length };
  }

  if (/^UPDATE core_v0_subjects SET sequence=\$3/i.test(sql)) {
    const row = tables.core_v0_subjects.find(item => item.tenant_id === values[0] && item.subject_user_id === values[1]);
    if (!row) return { rows: [], rowCount: 0 };
    row.sequence = values[2];
    row.updated_at = values[3] || row.updated_at;
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE core_v0_admission_gates SET enabled=\$2/i.test(sql)) {
    const row = tables.core_v0_admission_gates.find(item => item.gate_id === values[0]);
    if (!row) return { rows: [], rowCount: 0 };
    row.enabled = values[1];
    row.close_epoch = values[2];
    row.updated_at = values[3];
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE core_v0_admission_leases SET status='released'/i.test(sql)) {
    const row = tables.core_v0_admission_leases.find(item => item.gate_id === values[0] && item.lease_id === values[1] && item.status === 'active');
    if (!row) return { rows: [], rowCount: 0 };
    row.status = 'released';
    row.released_at = values[2];
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE core_v0_repair_attempts SET /i.test(sql)) {
    const row = tables.core_v0_repair_attempts.find(item => item.repair_attempt_id === values[0]);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = values[1];
    row.error_code = values[2];
    row.external_receipt_status = values[3];
    row.external_receipt_id = values[4];
    row.core_commit_id = values[5];
    row.updated_at = values[6];
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unsupported fixture SQL: ${sql}`);
}

class FixtureClient {
  constructor(database) {
    this.database = database;
    this.transaction = null;
  }

  async query(rawSql, values = []) {
    const sql = normalize(rawSql);
    this.database.queries.push({ sql, values: clone(values) });
    if (/^BEGIN(?:\s+ISOLATION\s+LEVEL\s+[A-Z\s]+)?$/i.test(sql)) {
      await this.database.transactionTail;
      let release;
      const done = new Promise(resolve => { release = resolve; });
      this.database.transactionTail = done;
      this.transaction = { snapshot: clone(this.database.tables), release };
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.transaction?.release();
      this.transaction = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (this.transaction) {
        this.database.tables = this.transaction.snapshot;
        this.transaction.release();
      }
      this.transaction = null;
      return { rows: [] };
    }
    return execute(this.database.tables, sql, values);
  }

  release() {}
}

export function createCoreV0PostgresFixture({ onQuery = null } = {}) {
  const database = { tables: emptyTables(), queries: [], transactionTail: Promise.resolve() };
  const pool = {
    database,
    async connect() {
      const client = new FixtureClient(database);
      if (onQuery) {
        const original = client.query.bind(client);
        client.query = async (sql, values = []) => {
          await onQuery(sql, values);
          return original(sql, values);
        };
      }
      return client;
    },
    async query(sql, values = []) {
      const client = await this.connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    }
  };
  return pool;
}
