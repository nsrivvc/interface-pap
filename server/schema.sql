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

-- Records dropped or flagged by any stage (bad volume/price, parse errors, etc.)
CREATE TABLE IF NOT EXISTS pipeline_exceptions (
  id         SERIAL PRIMARY KEY,
  batch_id   TEXT,
  source     TEXT,
  stage      TEXT,
  severity   TEXT NOT NULL DEFAULT 'error', -- error | warning
  message    TEXT NOT NULL,
  record     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- ---------------------------------------------------------------------------
-- Additional (reference) tables
--
-- Not written by any pipeline stage — maintained by hand and surfaced in the
-- Table Viewer's "Additional Tables" section. The interface reads them as
-- empty until they exist, so creating them is optional.
-- Column names are quoted to keep their mixed case in Postgres.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shipping (
  "KHolderName" text,
  "KHolderNo"   text
);

-- Pipelines added through Configure Components. Extra attribute columns added
-- here (or in Neon by hand) show up in the UI automatically — the grid and
-- add-row form introspect the live column list. DUNS stays text because it
-- carries leading zeros ("094992187").
CREATE TABLE IF NOT EXISTS public.pipeline_attributes (
  id                         serial PRIMARY KEY,
  "Pipeline"                 text,
  "DUNS"                     text,
  "ContractDateStructure"    text,
  "LocationEntDateStructure" text,
  "Segmented"                text,
  "AmendmentReporting"       text,
  "PipelineType"             text,
  "Source"                   text,
  "Seasons"                  text
);
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Pipeline" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "DUNS" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "ContractDateStructure" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "LocationEntDateStructure" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Segmented" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "AmendmentReporting" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "PipelineType" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Source" text;
ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Seasons" text;

-- Starter rows for the pipeline attribute table (seeded only when empty)
INSERT INTO public.pipeline_attributes
  ("Pipeline", "DUNS", "ContractDateStructure", "LocationEntDateStructure",
   "Segmented", "AmendmentReporting", "PipelineType", "Source", "Seasons")
SELECT * FROM (VALUES
  ('Carolina Gas Transmission, LLC', '094992187', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Transportation & Storage', 'gTRAN FIRM', 'NA'),
  ('Destin Pipeline Company, L.L.C.', '809423697', 'Inclusive', 'NA', 'No', 'NA', 'Transportation', 'gINDEX IOC', 'NA'),
  ('Gulfstream Natural Gas System, L.L.C.', '017738746', 'Inclusive', 'Exclusive', 'No', 'All Data', 'Transportation & Storage', 'gTRAN IT', 'NA'),
  ('BBT (Midla), LLC', '057111270', 'Inclusive', 'Exclusive', 'No', 'All Data', 'Transportation', 'gTRAN FIRM', 'NA'),
  ('Columbia Gas Transmission, LLC', '054748041', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Transportation & Storage', 'gXCHANGE Awards', 'NA'),
  ('Golden Triangle Storage, Inc.', '808627587', 'Exclusive', 'Exclusive', 'No', 'All Data', 'Storage', 'gXCHANGE Awards', 'NA'),
  ('Golden Triangle Storage, Inc.', '808627587', 'Inclusive', 'NA', 'No', 'NA', 'Storage', 'gINDEX IOC', 'NA'),
  ('Pine Prairie Energy Center, LLC', '187408526', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Transportation & Storage', 'gTRAN IT', 'NA'),
  ('Pine Prairie Energy Center, LLC', '187408526', 'Inclusive', 'NA', 'No', 'NA', 'Transportation & Storage', 'gINDEX IOC', 'NA'),
  ('ANR Pipeline Company', '006958581', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Transportation & Storage', 'gTRAN IT', 'NA'),
  ('Bobcat Gas Storage', '614834559', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Storage', 'gTRAN FIRM', 'NA'),
  ('Elba Express Company, L.L.C.', '828834445', 'Inclusive', 'Inclusive', 'No', 'All Data', 'Transportation & Storage', 'gXCHANGE Awards', 'NA'),
  ('Panhandle Eastern Pipe Line Company, LP', '045256641', 'Inclusive', 'NA', 'No', 'NA', 'Transportation & Storage', 'gINDEX IOC', 'NA')
) v("Pipeline", "DUNS", "ContractDateStructure", "LocationEntDateStructure",
    "Segmented", "AmendmentReporting", "PipelineType", "Source", "Seasons")
WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_attributes);

-- Stage 4 rec-del pairing config — one row per entry of the pairing JSON
-- ({ Pipeline, DUNS, Order, Pattern, Regex }), managed from Configure
-- Components and previewable there as the exact JSON array.
CREATE TABLE IF NOT EXISTS public.rec_del_pairings (
  id         serial PRIMARY KEY,
  "Pipeline" text NOT NULL DEFAULT 'default',
  "DUNS"     bigint NOT NULL DEFAULT 0,
  "Order"    integer,
  "Pattern"  text,
  "Regex"    text
);

-- Seed the default patterns so the config starts out matching the pipeline's file
INSERT INTO public.rec_del_pairings ("Pipeline", "DUNS", "Order", "Pattern", "Regex")
SELECT * FROM (VALUES
  ('default', 0::bigint, 1, 'R^n-D^m (n>=1,m>=1)', '^R(?:-R)*-D(?:-D)*$'),
  ('default', 0::bigint, 2, 'D^n-R^m (n>=1,m>=1)', '^D(?:-D)*-R(?:-R)*$'),
  ('default', 0::bigint, 3, 'Alternating R-D', '^(R-D)+$'),
  ('default', 0::bigint, 4, 'Alternating D-R', '^(D-R)+$'),
  ('default', 0::bigint, 5, 'Alternating R-D-R', '^(R-D-R)+$'),
  ('default', 0::bigint, 6, 'Alternating D-R-D', '^(D-R-D)+$')
) v("Pipeline", "DUNS", "Order", "Pattern", "Regex")
WHERE NOT EXISTS (SELECT 1 FROM public.rec_del_pairings);

-- Location purpose codes per pipeline, managed from Configure Components.
-- DUNS stays text because it carries leading zeros ("054748041").
CREATE TABLE IF NOT EXISTS public.location_purpose_code (
  id                    serial PRIMARY KEY,
  "Pipeline"            text,
  "DUNS"                text,
  "Loc_QTI"             text,
  "StandardizedLocPurp" text,
  "Source"              text
);
ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Pipeline" text;
ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "DUNS" text;
ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Loc_QTI" text;
ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "StandardizedLocPurp" text;
ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Source" text;

-- Starter rows for the location purpose code table (seeded only when empty)
INSERT INTO public.location_purpose_code
  ("Pipeline", "DUNS", "Loc_QTI", "StandardizedLocPurp", "Source")
SELECT * FROM (VALUES
  ('Egan Hub Storage, LLC', '835460478', 'Delivery Location', 'Delivery Location', 'gTRAN FIRM'),
  ('Eastern Gas Transmission and Storage, Inc.', '116025180', 'Injection Point', 'Injection Location', 'gINDEX IOC'),
  ('EASTERN GAS TRANSMISSION AND STORAGE, INC.', '116025180', 'METERING LOCATION/DELIVERY LOCATION', NULL, 'gXCHANGE AWARDS'),
  ('Tres Palacios Gas Storage', '791204600', NULL, NULL, 'gXCHANGE AWARDS'),
  ('Columbia Gas Transmission, LLC', '054748041', 'METERING LOCATION/DELIVERY LOCATION', 'Delivery Location', 'gXCHANGE AWARDS'),
  ('Golden Triangle Storage, Inc.', '808627587', 'Receipt Location', 'Receipt Location', 'gTRAN IT'),
  ('Texas Gas Transmission, LLC', '115972101', 'Pipeline segment defined by 1 location', 'Receipt Location', 'gXCHANGE AWARDS'),
  ('Bobcat Gas Storage', '614834559', 'Delivery Location', 'Delivery Location', 'gTRAN IT'),
  ('Carolina Gas Transmission, LLC', '094992187', 'Delivery Point', 'Delivery Location', 'gINDEX IOC'),
  ('Southeast Supply Header, LLC', '808264746', 'METERING LOCATION/DELIVERY LOCATION', 'Delivery Location', 'gXCHANGE AWARDS'),
  ('Monroe Gas Storage Company, L.L.C.', '790550920', 'Delivery Point', 'Delivery Location', 'gINDEX IOC'),
  ('Tres Palacios Gas Storage', '791204600', NULL, NULL, 'gXCHANGE AWARDS'),
  ('East Tennessee Natural Gas, LLC', '007921323', 'RECEIPT METER LOCATION', 'Receipt Location', 'gXCHANGE AWARDS')
) v("Pipeline", "DUNS", "Loc_QTI", "StandardizedLocPurp", "Source")
WHERE NOT EXISTS (SELECT 1 FROM public.location_purpose_code);
