-- Core v0 operational facts. Memory facts remain owned by the Memory schema.

CREATE TABLE IF NOT EXISTS core_v0_subjects (
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_user_id)
);

CREATE TABLE IF NOT EXISTS core_v0_turn_admissions (
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  turn_id text NOT NULL,
  application_session_id text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  message text NOT NULL,
  channel text NOT NULL,
  binding_key text NOT NULL,
  memory_session_id text,
  application_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  event_id text NOT NULL,
  source_revision text NOT NULL,
  sequence_no bigint NOT NULL,
  commit_id text NOT NULL,
  admission_receipt_id text NOT NULL,
  pending_receipt_id text,
  status text NOT NULL CHECK (status IN ('admission_pending', 'pending', 'admitted', 'context_ready', 'generation_succeeded', 'commit_pending', 'committed', 'failed')),
  memory_status text NOT NULL CHECK (memory_status IN ('pending', 'available', 'degraded')),
  memory_answerability text,
  raw_event_receipt jsonb,
  generated_content text,
  result jsonb,
  failure jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  committed_at timestamptz,
  PRIMARY KEY (tenant_id, turn_id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES core_v0_subjects (tenant_id, subject_user_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, subject_user_id, application_session_id, idempotency_key),
  UNIQUE (tenant_id, subject_user_id, application_session_id, source_revision),
  UNIQUE (tenant_id, subject_user_id, application_message_id),
  UNIQUE (tenant_id, subject_user_id, event_id)
);

CREATE INDEX IF NOT EXISTS core_v0_turn_subject_idx
  ON core_v0_turn_admissions (tenant_id, subject_user_id, application_session_id, sequence_no);

CREATE TABLE IF NOT EXISTS core_v0_memory_session_bindings (
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  binding_id text NOT NULL,
  binding_key text NOT NULL,
  application_session_id text NOT NULL,
  memory_session_id text,
  memory_contract_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  receipt jsonb,
  last_error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, binding_id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES core_v0_subjects (tenant_id, subject_user_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, subject_user_id, application_session_id),
  UNIQUE (tenant_id, subject_user_id, binding_key),
  UNIQUE (tenant_id, subject_user_id, memory_session_id)
);

CREATE TABLE IF NOT EXISTS core_v0_assistant_commits (
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  commit_id text NOT NULL,
  turn_id text NOT NULL,
  application_session_id text NOT NULL,
  assistant_message_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  content text,
  receipt_id text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, commit_id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES core_v0_subjects (tenant_id, subject_user_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, subject_user_id, assistant_message_id)
);

CREATE TABLE IF NOT EXISTS core_v0_messages (
  tenant_id text NOT NULL,
  subject_user_id text NOT NULL,
  application_message_id text NOT NULL,
  application_session_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL,
  channel text,
  created_at timestamptz NOT NULL,
  visible_at timestamptz,
  core_v0 jsonb NOT NULL,
  PRIMARY KEY (tenant_id, application_message_id),
  FOREIGN KEY (tenant_id, subject_user_id) REFERENCES core_v0_subjects (tenant_id, subject_user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS core_v0_messages_session_idx
  ON core_v0_messages (tenant_id, subject_user_id, application_session_id, created_at);

CREATE TABLE IF NOT EXISTS core_v0_admission_gates (
  gate_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  close_epoch bigint NOT NULL DEFAULT 0 CHECK (close_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core_v0_admission_leases (
  gate_id text NOT NULL,
  lease_id text NOT NULL,
  admission_key text NOT NULL,
  tenant_id text,
  subject_user_id text,
  turn_id text,
  close_epoch bigint NOT NULL CHECK (close_epoch >= 0),
  status text NOT NULL CHECK (status IN ('active', 'released')),
  lease_owner text,
  acquired_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (gate_id, lease_id),
  FOREIGN KEY (gate_id) REFERENCES core_v0_admission_gates (gate_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS core_v0_active_admission_key_idx
  ON core_v0_admission_leases (gate_id, admission_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS core_v0_active_leases_idx
  ON core_v0_admission_leases (gate_id, status, acquired_at);

CREATE TABLE IF NOT EXISTS core_v0_repair_attempts (
  repair_attempt_id text PRIMARY KEY,
  gate_id text,
  tenant_id text,
  subject_user_id text,
  turn_id text,
  lease_id text,
  operation text NOT NULL,
  adapter text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  error_code text,
  attempt integer NOT NULL CHECK (attempt >= 1),
  operator_id text NOT NULL,
  close_epoch bigint,
  lease_owner text,
  external_receipt_status text,
  external_receipt_id text,
  core_commit_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE core_v0_repair_attempts
  ADD COLUMN IF NOT EXISTS external_receipt_id text;

ALTER TABLE core_v0_repair_attempts
  ADD COLUMN IF NOT EXISTS core_commit_id text;

CREATE TABLE IF NOT EXISTS core_v0_crash_records (
  crash_record_id text PRIMARY KEY,
  gate_id text,
  tenant_id text,
  subject_user_id text,
  turn_id text,
  lease_id text,
  process_id text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('observed', 'reconciled', 'unresolved')),
  error_code text,
  operator_id text NOT NULL,
  close_epoch bigint,
  observed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS core_v0_repair_lookup_idx
  ON core_v0_repair_attempts (tenant_id, subject_user_id, turn_id, status, updated_at);
