-- interface-pap schema — everything lives in one Neon database

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw JSON retrieved from the (dummy) source system
CREATE TABLE IF NOT EXISTS source_data (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  payload      JSONB NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stage tables: each stage transforms the previous stage's output
CREATE TABLE IF NOT EXISTS stage1_validated (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage2_normalized (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage3_enriched (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage4_aggregated (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage5_published (
  id           SERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  record       JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workflow definitions (schedule_minutes = null means manual only)
CREATE TABLE IF NOT EXISTS workflows (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  schedule_minutes INTEGER,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  last_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id          SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id),
  batch_id    TEXT,
  status      TEXT NOT NULL DEFAULT 'running', -- running | success | failed
  log         JSONB NOT NULL DEFAULT '[]',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Seed the default full-pipeline workflow
INSERT INTO workflows (name, description)
SELECT 'Full Pipeline', 'Retrieve source then run Stages 1-5 end to end'
WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE name = 'Full Pipeline');
