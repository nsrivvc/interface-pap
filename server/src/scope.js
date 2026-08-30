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

let scopeEnsured = false;
async function ensureScopeTable() {
  if (scopeEnsured) return;
  for (const stmt of ENSURE_STATEMENTS) await sql.query(stmt);
  scopeEnsured = true;
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
