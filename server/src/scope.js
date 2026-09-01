// Applies the scenario attached to a workflow as the data pipeline's shipper
// scope — the bridge between "attach a scenario on the dashboard" and "the
// pipeline actually processes only those shippers".
//
// The pipeline's stage-3 deduplication filters every Bronze feed through
// bronze.shipper_mapping (see src/core/shipper_scope.py in the STAGE_3_4_5
// repo): no 'add' rows = unscoped (everything passes), one or more 'add'
// rows = only those DUNS pass. Both apps share one Neon database, so writing
// that table here and then dispatching the workflows is all the wiring needed
// — the dispatched runs rebuild staging with --reload and read the scope
// table live.
//
// Semantics kept deliberately simple and reproducible: every run SETS the
// scope to exactly the attached scenario's shipper picks, and a run with no
// scenario (or a scenario with no shipper picks) CLEARS it. The table is
// owned by this dashboard; nothing else writes it.
import { sql, hasDb } from './db.js';

// Mirrors shipper_scope.ddl() in the pipeline repo — same table, columns and
// constraint names, so whichever side runs first provisions it and the other
// side's CREATE IF NOT EXISTS is a no-op.
const ENSURE_STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS bronze`,
  `CREATE TABLE IF NOT EXISTS bronze.shipper_mapping (
      id            BIGSERIAL PRIMARY KEY,
      workflow_id   INTEGER,
      source        TEXT,
      kholdernumber TEXT NOT NULL,
      kholdername   TEXT,
      action        TEXT NOT NULL DEFAULT 'add'
                    CHECK (action IN ('add', 'remove')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uq_shipper_mapping_scope
          UNIQUE NULLS NOT DISTINCT (workflow_id, source, kholdernumber)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_shipper_mapping_lookup
      ON bronze.shipper_mapping (action, source, kholdernumber)`,
];

// Mirrors pipeline_scope.ddl() / the amendments DDL in the pipeline repo. The
// REGISTER of pipelines the warehouse is allowed to process: a contract whose
// TSP is absent here is held back at deduplication(p1) and reported, while
// registered TSPs in the same load carry on. Lives in the staging schema
// because that is where the pipeline's phases read it.
const PIPELINE_SCHEMA = process.env.DECOMP_SCHEMA || 'silver_staging';
const ENSURE_PIPELINE_STATEMENTS = [
  `CREATE SCHEMA IF NOT EXISTS ${PIPELINE_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${PIPELINE_SCHEMA}.pipeline_attributes (
      tspduns             TEXT PRIMARY KEY,
      tspname             TEXT,
      amendment_reporting TEXT NOT NULL,
      noted_ts            TIMESTAMPTZ DEFAULT now()
  )`,
];

// The pipeline's amendments phase REJECTS the whole run if the register holds a
// mode its CLASSIFY join cannot read, so only these spellings may be written.
// The dashboard's reference table also carries "NA" (for IOC-sourced rows),
// which is not a usable amendment mode — those rows are skipped rather than
// projected, or they would fail every subsequent run.
const AMENDMENT_MODES = ['all data', 'alldata', 'all', 'changes only', 'changesonly', 'changes'];
const usableMode = (mode) => AMENDMENT_MODES.includes(String(mode ?? '').trim().toLowerCase());

let scopeEnsured = false;
async function ensureScopeTable() {
  if (scopeEnsured) return;
  for (const stmt of ENSURE_STATEMENTS) await sql.query(stmt);
  scopeEnsured = true;
}

let pipelineEnsured = false;
async function ensurePipelineTable() {
  if (pipelineEnsured) return;
  for (const stmt of ENSURE_PIPELINE_STATEMENTS) await sql.query(stmt);
  pipelineEnsured = true;
}

// Scenario shipper picks are the display labels from /api/scenario-options:
// "KHolderName (KHolderNo)", or a bare name when the reference row has no
// number. The DUNS in the trailing parentheses is what the pipeline scopes by.
function parseShipperLabel(label) {
  const m = /^(.*)\(([^()]+)\)\s*$/.exec(label);
  if (m && m[2].trim()) return { duns: m[2].trim(), name: m[1].trim() || null };
  if (/^\d+$/.test(label.trim())) return { duns: label.trim(), name: null };
  return null; // no number to scope by — reported back as unmatched
}

/**
 * Pin bronze.shipper_mapping to the scenario's shipper picks (or clear it
 * when no scenario is attached). Returns a summary for the client to show.
 * Throws when a scenario is expected but cannot be applied — better a failed
 * trigger than a run the user believes is scoped and isn't.
 */
export async function applyScenarioScope(scenarioId) {
  const id = Number(scenarioId);
  const wantScope = Number.isInteger(id) && id > 0;

  if (!hasDb) {
    if (wantScope) {
      throw new Error(
        'A scenario is attached but no database is connected — set DATABASE_URL in server/.env, ' +
          'or detach the scenario to run unscoped.'
      );
    }
    return { scoped: false, reason: 'no database connected — scope untouched' };
  }

  await ensureScopeTable();

  if (!wantScope) {
    await sql`DELETE FROM bronze.shipper_mapping`;
    return { scoped: false, reason: 'no scenario attached — every shipper passes' };
  }

  const [scenario] = await sql`SELECT id, name, config FROM scenarios WHERE id = ${id}`;
  if (!scenario) {
    throw new Error(
      `The attached scenario (id ${id}) no longer exists — edit the workflow and pick another.`
    );
  }

  const picks = Array.isArray(scenario.config?.shipper) ? scenario.config.shipper : [];
  const shippers = [];
  const unmatched = [];
  const seen = new Set();
  for (const label of picks) {
    if (typeof label !== 'string' || !label.trim()) continue;
    const parsed = parseShipperLabel(label);
    if (!parsed) {
      unmatched.push(label);
    } else if (!seen.has(parsed.duns)) {
      seen.add(parsed.duns);
      shippers.push(parsed);
    }
  }

  if (!shippers.length) {
    await sql`DELETE FROM bronze.shipper_mapping`;
    return {
      scoped: false,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      unmatched,
      reason: 'scenario pins no shippers — every shipper passes',
    };
  }

  // Atomic replace: the whole scope is exactly this scenario, never a mix of
  // old and new rows. source NULL = the scope applies to every feed.
  await sql.transaction([
    sql`DELETE FROM bronze.shipper_mapping`,
    sql`INSERT INTO bronze.shipper_mapping (source, kholdernumber, kholdername, action)
        SELECT NULL, u.duns, u.name, 'add'
        FROM unnest(
          ${shippers.map((s) => s.duns)}::text[],
          ${shippers.map((s) => s.name)}::text[]
        ) AS u(duns, name)`,
  ]);

  return {
    scoped: true,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    shippers,
    unmatched,
  };
}

/**
 * Pin the pipeline register to the scenario's Pipeline picks.
 *
 * `public.pipeline_attributes` is the dashboard's reference data ("Pipeline",
 * "DUNS", "AmendmentReporting"); the pipeline reads a differently-shaped table
 * in the staging schema (tspduns, tspname, amendment_reporting). This projects
 * one onto the other so a scenario is genuinely the config piece: the
 * pipelines it pins are the pipelines the run is allowed to process, and a
 * contract from any other TSP is held back at deduplication(p1) and reported.
 *
 * No picks = mirror EVERY onboarded pipeline. Deliberately not "let everything
 * through": the register's whole purpose is the onboarding gate, so an
 * unspecific scenario should still reject a pipeline nobody has onboarded —
 * it just should not narrow further than the reference data already does.
 *
 * Rows whose AmendmentReporting is not a mode the pipeline's CLASSIFY join can
 * read (the reference table's "NA") are skipped and reported back as
 * `unusable`, because writing one would fail every subsequent amendments run.
 */
export async function applyScenarioPipelines(scenarioId) {
  if (!hasDb) return { applied: false, reason: 'no database connected — register untouched' };

  await ensurePipelineTable();

  // The reference table is optional — a deployment that has never created it
  // simply has no register to project, and the gate stays open.
  const [{ exists } = {}] = await sql`
    SELECT to_regclass('public.pipeline_attributes') IS NOT NULL AS exists`;
  if (!exists) {
    return { applied: false, reason: 'no public.pipeline_attributes reference table' };
  }

  const reference = await sql`
    SELECT "Pipeline" AS name, "DUNS" AS duns, "AmendmentReporting" AS mode
    FROM public.pipeline_attributes
    WHERE "DUNS" IS NOT NULL AND btrim("DUNS") <> ''`;

  const id = Number(scenarioId);
  let picked = null; // null = no scenario/no picks = every onboarded pipeline
  if (Number.isInteger(id) && id > 0) {
    const [scenario] = await sql`SELECT config FROM scenarios WHERE id = ${id}`;
    const picks = Array.isArray(scenario?.config?.pipeline) ? scenario.config.pipeline : [];
    // Picks are the "Name (DUNS)" labels from /api/scenario-options.
    const dunsPicks = picks
      .map((label) => parseShipperLabel(String(label ?? '')))
      .filter(Boolean)
      .map((p) => p.duns);
    if (dunsPicks.length) picked = new Set(dunsPicks);
  }

  // One row per DUNS. A pipeline can appear several times in the reference
  // table (one row per source feed), so prefer a row carrying a usable
  // amendment mode over one that only says "NA".
  const byDuns = new Map();
  const unusable = new Map();
  for (const row of reference) {
    const duns = String(row.duns).trim();
    if (picked && !picked.has(duns)) continue;
    if (!usableMode(row.mode)) {
      if (!byDuns.has(duns)) unusable.set(duns, row.name);
      continue;
    }
    unusable.delete(duns);
    if (!byDuns.has(duns)) byDuns.set(duns, { duns, name: row.name, mode: String(row.mode).trim() });
  }

  const rows = [...byDuns.values()];
  if (!rows.length) {
    // Leave the register EMPTY rather than half-populated: the pipeline reads
    // an empty register as "nothing configured, everything passes", which is a
    // safer failure than rejecting every contract in the feed.
    await sql.query(`DELETE FROM ${PIPELINE_SCHEMA}.pipeline_attributes`);
    return {
      applied: false,
      unusable: [...unusable.entries()].map(([duns, name]) => ({ duns, name })),
      reason: 'no onboarded pipeline has a usable amendment mode — gate left open',
    };
  }

  // Atomic replace, same as the shipper scope: the register is exactly this
  // scenario's pipelines, never a mix of old and new rows.
  await sql.transaction([
    sql.query(`DELETE FROM ${PIPELINE_SCHEMA}.pipeline_attributes`),
    sql.query(
      `INSERT INTO ${PIPELINE_SCHEMA}.pipeline_attributes (tspduns, tspname, amendment_reporting)
       SELECT u.duns, u.name, u.mode
       FROM unnest($1::text[], $2::text[], $3::text[]) AS u(duns, name, mode)`,
      [rows.map((r) => r.duns), rows.map((r) => r.name), rows.map((r) => r.mode)]
    ),
  ]);

  return {
    applied: true,
    scoped: Boolean(picked),
    pipelines: rows.map((r) => ({ duns: r.duns, name: r.name })),
    unusable: [...unusable.entries()].map(([duns, name]) => ({ duns, name })),
  };
}
