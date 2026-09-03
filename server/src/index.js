// The entire backend API — every route the app calls lives in this one file,
// grouped under section banners:
//   Auth · Tables · Configure Components · Configure Source · Scenarios ·
//   Pipeline filter options · Power BI · Pipeline · Workflows
// Locally it listens on :4000; on Vercel the very same app is exported and
// served by api/index.js as a single serverless function.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { sql } from './db.js';
import { requireAuth } from './auth.js';
import { registerAccountRoutes, requireAdmin } from './accounts.js';
import { retrieveSource, runStage, runFullPipeline } from './pipeline.js';
import { reloadSchedules } from './scheduler.js';
import { registerDownloadRoute } from './downloads.js';
import { triggerPipeline, triggerIngest, pipelineRunStatus, cancelPipelineRuns } from './github.js';
import { applyScenarioScope, applyScenarioPipelines } from './scope.js';
import { powerbiAadToken, powerbiConfigured, goldReportEmbed } from './powerbi.js';
import { provider, FEED_KEYS, feedSummaries } from './providers/index.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // gold-view rows ride in the body

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(400).json({ error: err.message }));

// ---------- Auth & accounts ----------
// Sign-up, sign-in and account management all live in accounts.js, which also
// defines the two roles and the requireAdmin gate the routes below use.
registerAccountRoutes(app, wrap);

// ---------- Tables ----------
// Every table the viewer exposes, derived from the ACTIVE source API in
// server/src/providers/. The virtual names (raw_firm, firm_core_standardized…)
// are what the UI and downloads address; `backing` is the physical table that
// API's pipeline actually writes. Changing API means editing a provider file,
// not this list. A feed that stops before a stage contributes nothing to it.
const FEEDS = FEED_KEYS.map((key) => ({ key, ...provider.feeds[key] }));
const CAP = { locations: 'Locations', core: 'Core', rates: 'Rates' };

// One virtual table, or undefined when this feed has no table at that stage.
const vt = (spec, name, label) =>
  spec && { name, label, backing: spec.table, orderBy: spec.orderBy };

const grains = (order, build) => FEEDS.flatMap((f) => order.map((g) => build(f, g)));

// Stage 3 runs in phases for the feeds that declare `silverPhases` (Firm, IT):
// duplicates dropped, amendments applied and multi-part records decomposed,
// each landing one table, before the standardized tables are built. A feed
// without them (Awards) contributes only its standardized tables.
const SILVER_PHASES = [
  { key: 'deduplicated', label: 'Deduplicated' },
  { key: 'amended', label: 'Amended' },
  { key: 'decomposed', label: 'Decomposed' },
];

const STAGE_TABLES = [
  {
    stage: 'Stage 1 — API to Raw',
    tables: FEEDS.map((f) => vt(f.tables.bronze, `raw_${f.key}`, `${f.label} JSON`)).filter(Boolean),
  },
  {
    stage: 'Stage 2 — JSON-Bronze',
    tables: FEEDS.map((f) =>
      vt(f.tables.bronze, `bronze_${f.key}`, `${f.label} Raw Table`)
    ).filter(Boolean),
  },
  {
    stage: 'Stage 3 — Silver Staging',
    tables: FEEDS.flatMap((f) => [
      ...SILVER_PHASES.map((p) =>
        vt(f.tables.silverPhases?.[p.key], `${f.key}_${p.key}`, `${f.label} — ${p.label}`)
      ),
      ...['locations', 'core', 'rates'].map((g) =>
        vt(
          f.tables.silverStaging?.[g],
          `${f.key}_${g}_standardized`,
          `${f.label} ${CAP[g]} — Standardized`
        )
      ),
    ]).filter(Boolean),
  },
  {
    stage: 'Stage 4 — Rec-Del Pairing',
    tables: FEEDS.map((f) =>
      vt(
        f.tables.recDel,
        `${f.key}_locations_standardized_transformed`,
        `${f.label} Locations — Standardized (Transformed)`
      )
    ).filter(Boolean),
  },
  {
    stage: 'Stage 5 — Master Capacity',
    tables: [
      ...grains(['core', 'locations', 'rates'], (f, g) =>
        vt(
          f.tables.masterCapacity?.[g],
          `${f.key}_${g}_master_capacity`,
          `${f.label} ${CAP[g]} — Master Capacity`
        )
      ),
      // Cross-feed finals belong to the provider, not to any one feed
      ...['core', 'locations', 'rates'].map((g) =>
        vt(provider.finalTables?.[g], `final_${g}_master_capacity`, `Final ${CAP[g]} — Master Capacity`)
      ),
    ].filter(Boolean),
  },
  // Reference tables kept alongside the pipeline rather than produced by it.
  // The physical tables are created in Neon by hand; until they exist these
  // read as empty instead of erroring. See server/schema.sql for the DDL.
  {
    stage: 'Additional Tables',
    tables: [
      {
        name: 'shipping',
        label: 'Shipping Table',
        backing: 'public.shipping',
        orderBy: '"KHolderNo"',
      },
      {
        name: 'pipeline_attributes',
        label: 'Pipeline Attribute Table',
        backing: 'public.pipeline_attributes',
      },
      {
        name: 'rec_del_pairings',
        label: 'Rec-Del Pairing Config',
        backing: 'public.rec_del_pairings',
        orderBy: '"Order"',
      },
      {
        name: 'location_purpose_code',
        label: 'Location Purpose Code Table',
        backing: 'public.location_purpose_code',
      },
    ],
  },
  // Operational tables — the same whichever API is upstream
  {
    stage: 'Logging',
    tables: [{ name: 'workflow_runs', label: 'Workflow Run Logs', backing: 'workflow_runs' }],
  },
  {
    stage: 'Exceptions',
    tables: [
      { name: 'pipeline_exceptions', label: 'Pipeline Exceptions', backing: 'pipeline_exceptions' },
    ],
  },
];

const TABLE_INDEX = Object.fromEntries(
  STAGE_TABLES.flatMap((s) => s.tables.map((t) => [t.name, t]))
);

// ---------- Source API ----------
// Which upstream API this server is pulling from, and what it calls its feeds.
app.get('/api/provider', requireAuth, (req, res) => {
  res.json({
    key: provider.key,
    label: provider.label,
    description: provider.description,
    repo: provider.repo,
    feeds: feedSummaries(),
  });
});

app.get('/api/tables', requireAuth, wrap(async (req, res) => {
  // Row counts for every backing table in two round trips (which tables exist,
  // then one combined count query) — the previous per-table count(*) loop cost
  // a full HTTP round trip to Neon for each of the ~30 tables, sequentially.
  const backings = [...new Set(Object.values(TABLE_INDEX).map((t) => t.backing))];
  const counts = Object.fromEntries(backings.map((b) => [b, 0]));
  try {
    const existing = new Set(
      (await sql`SELECT schemaname || '.' || tablename AS name FROM pg_tables`).map((r) => r.name)
    );
    const present = backings.filter((b) => existing.has(b.includes('.') ? b : `public.${b}`));
    if (present.length) {
      const union = present
        .map((b, i) => `SELECT ${i} AS i, count(*)::int AS count FROM ${b}`)
        .join(' UNION ALL ');
      for (const row of await sql.query(union)) counts[present[row.i]] = row.count;
    }
  } catch {
    // no database yet — every table reads as empty
  }
  const stages = STAGE_TABLES.map((s) => ({
    stage: s.stage,
    tables: s.tables.map((t) => ({ name: t.name, label: t.label, rowCount: counts[t.backing] })),
  }));
  res.json({ stages });
}));

registerDownloadRoute(app, TABLE_INDEX);

app.get('/api/tables/:name', requireAuth, wrap(async (req, res) => {
  const table = TABLE_INDEX[req.params.name];
  if (!table) throw new Error('Unknown table.');
  let rows = [];
  try {
    rows = await sql.query(
      `SELECT * FROM ${table.backing} ORDER BY ${table.orderBy || 'id'} DESC LIMIT 200`
    );
  } catch {
    // No database — show an empty table
  }
  res.json({ name: table.name, label: table.label, rows });
}));

// ---------- Configure Components ----------
// The editable reference tables behind the workflow "Configure Components"
// card. Each spec carries the DDL to lazily create (and seed) its backing
// table, so adding a row works on a fresh database without running schema.sql
// by hand. Columns are introspected live — add a column in Neon and the UI's
// grid + add-row form pick it up automatically. `columns` is only the no-DB
// fallback so the grids still render in local mode.
const COMPONENT_TABLES = {
  'pipeline-attributes': {
    backing: 'public.pipeline_attributes',
    ensure: [
      `CREATE TABLE IF NOT EXISTS public.pipeline_attributes (id serial PRIMARY KEY)`,
      // Migrate the earlier minimal shape (PipelineName/DUNS) to the real one
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'pipeline_attributes'
                      AND column_name = 'PipelineName') THEN
           IF EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'pipeline_attributes'
                        AND column_name = 'Pipeline') THEN
             ALTER TABLE public.pipeline_attributes DROP COLUMN "PipelineName";
           ELSE
             ALTER TABLE public.pipeline_attributes RENAME COLUMN "PipelineName" TO "Pipeline";
           END IF;
         END IF;
       END $$`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Pipeline" text`,
      // DUNS stays text — it carries leading zeros ("094992187")
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "DUNS" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "ContractDateStructure" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "LocationEntDateStructure" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Segmented" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "AmendmentReporting" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "PipelineType" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Source" text`,
      `ALTER TABLE public.pipeline_attributes ADD COLUMN IF NOT EXISTS "Seasons" text`,
      `INSERT INTO public.pipeline_attributes
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
       WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_attributes)`,
    ],
    orderBy: 'id',
    columns: [
      { name: 'id', dataType: 'integer', auto: true },
      { name: 'Pipeline', dataType: 'text' },
      { name: 'DUNS', dataType: 'text' },
      { name: 'ContractDateStructure', dataType: 'text' },
      { name: 'LocationEntDateStructure', dataType: 'text' },
      { name: 'Segmented', dataType: 'text' },
      { name: 'AmendmentReporting', dataType: 'text' },
      { name: 'PipelineType', dataType: 'text' },
      { name: 'Source', dataType: 'text' },
      { name: 'Seasons', dataType: 'text' },
    ],
  },
  shipping: {
    backing: 'public.shipping',
    ensure: [
      `CREATE TABLE IF NOT EXISTS public.shipping ("KHolderName" text, "KHolderNo" text)`,
    ],
    orderBy: '"KHolderNo"',
    columns: [
      { name: 'KHolderName', dataType: 'text' },
      { name: 'KHolderNo', dataType: 'text' },
    ],
  },
  // One row per entry of the Stage 4 rec-del pairing JSON — the rows ARE the
  // JSON array (Pipeline, DUNS, Order, Pattern, Regex), seeded with the
  // default patterns so the config starts out matching the pipeline's file.
  'rec-del-pairings': {
    backing: 'public.rec_del_pairings',
    ensure: [
      `CREATE TABLE IF NOT EXISTS public.rec_del_pairings (
        id serial PRIMARY KEY,
        "Pipeline" text NOT NULL DEFAULT 'default',
        "DUNS" bigint NOT NULL DEFAULT 0,
        "Order" integer,
        "Pattern" text,
        "Regex" text
      )`,
      `INSERT INTO public.rec_del_pairings ("Pipeline", "DUNS", "Order", "Pattern", "Regex")
       SELECT * FROM (VALUES
         ('default', 0::bigint, 1, 'R^n-D^m (n>=1,m>=1)', '^R(?:-R)*-D(?:-D)*$'),
         ('default', 0::bigint, 2, 'D^n-R^m (n>=1,m>=1)', '^D(?:-D)*-R(?:-R)*$'),
         ('default', 0::bigint, 3, 'Alternating R-D', '^(R-D)+$'),
         ('default', 0::bigint, 4, 'Alternating D-R', '^(D-R)+$'),
         ('default', 0::bigint, 5, 'Alternating R-D-R', '^(R-D-R)+$'),
         ('default', 0::bigint, 6, 'Alternating D-R-D', '^(D-R-D)+$')
       ) v("Pipeline", "DUNS", "Order", "Pattern", "Regex")
       WHERE NOT EXISTS (SELECT 1 FROM public.rec_del_pairings)`,
    ],
    orderBy: '"Order", id',
    columns: [
      { name: 'id', dataType: 'integer', auto: true },
      { name: 'Pipeline', dataType: 'text' },
      { name: 'DUNS', dataType: 'bigint' },
      { name: 'Order', dataType: 'integer' },
      { name: 'Pattern', dataType: 'text' },
      { name: 'Regex', dataType: 'text' },
    ],
  },
  'location-purpose-code': {
    backing: 'public.location_purpose_code',
    ensure: [
      `CREATE TABLE IF NOT EXISTS public.location_purpose_code (id serial PRIMARY KEY)`,
      `ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Pipeline" text`,
      // DUNS stays text — it carries leading zeros ("054748041")
      `ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "DUNS" text`,
      `ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Loc_QTI" text`,
      `ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "StandardizedLocPurp" text`,
      `ALTER TABLE public.location_purpose_code ADD COLUMN IF NOT EXISTS "Source" text`,
      `INSERT INTO public.location_purpose_code
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
       WHERE NOT EXISTS (SELECT 1 FROM public.location_purpose_code)`,
    ],
    orderBy: 'id',
    columns: [
      { name: 'id', dataType: 'integer', auto: true },
      { name: 'Pipeline', dataType: 'text' },
      { name: 'DUNS', dataType: 'text' },
      { name: 'Loc_QTI', dataType: 'text' },
      { name: 'StandardizedLocPurp', dataType: 'text' },
      { name: 'Source', dataType: 'text' },
    ],
  },
};

const componentSpec = (key) => {
  const spec = COMPONENT_TABLES[key];
  if (!spec) throw new Error('Unknown component table.');
  return spec;
};

// Create/seed the backing table once per process; a failure (no database)
// just means the caller falls back to the spec's static column list.
async function ensureComponentTable(spec) {
  if (spec._ensured) return true;
  try {
    for (const ddl of spec.ensure) await sql.query(ddl);
    spec._ensured = true;
    await tidyIds(spec); // close any gaps left over from earlier edits
    return true;
  } catch {
    return false;
  }
}

// Live column list from Postgres so the grid and add-row form always match
// the real table; identity/serial columns are flagged so the form skips them.
async function componentColumns(spec) {
  const [schema, table] = spec.backing.split('.');
  const cols = await sql.query(
    `SELECT column_name AS name, data_type AS "dataType",
            (is_identity = 'YES' OR COALESCE(column_default, '') LIKE 'nextval(%') AS auto,
            (column_default IS NOT NULL) AS "hasDefault"
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  );
  return cols.length ? cols : spec.columns;
}

// Keep the id column reading 1, 2, 3… Deleting a row — or an insert that
// failed after the sequence had already handed out a number — leaves a hole,
// which looks like a missing row in the grid. This renumbers the rows in their
// existing id order and parks the sequence right after the last one. The usual
// case (no hole) costs a single count.
async function resequenceIds(spec) {
  const idCol = (await componentColumns(spec)).find((c) => c.auto);
  if (!idCol) return; // shipping has no id column at all
  const id = `"${idCol.name.replaceAll('"', '')}"`;
  const seq = `pg_get_serial_sequence('${spec.backing}', '${idCol.name}')`;
  const [{ n, max }] = await sql.query(
    `SELECT COUNT(*)::int AS n, COALESCE(MAX(${id}), 0)::int AS max FROM ${spec.backing}`
  );
  const park = `SELECT setval(${seq}, GREATEST(${n}, 1), ${n > 0})`;
  if (n === max) {
    await sql.query(park); // already contiguous — just make sure the next id follows on
    return;
  }
  // Renumber through negative ids: a straight UPDATE can collide with a row
  // that hasn't been renumbered yet, and the id is a primary key. One
  // transaction, so the ids are never left negative.
  await sql.transaction([
    sql.query(`UPDATE ${spec.backing} SET ${id} = -${id} WHERE ${id} > 0`),
    sql.query(
      `WITH ordered AS (
         SELECT ${id} AS old, row_number() OVER (ORDER BY ${id} DESC) AS rn
         FROM ${spec.backing} WHERE ${id} < 0
       )
       UPDATE ${spec.backing} t SET ${id} = o.rn FROM ordered o WHERE t.${id} = o.old`
    ),
    sql.query(park),
  ]);
}

// Tidying the ids is housekeeping — never let it fail the write that ran fine.
const tidyIds = async (spec) => {
  try {
    await resequenceIds(spec);
  } catch (err) {
    console.warn(`Could not resequence ${spec.backing} ids:`, err.message);
  }
};

app.get('/api/components/:key', requireAdmin, wrap(async (req, res) => {
  const spec = componentSpec(req.params.key);
  let columns = spec.columns;
  let rows = [];
  if (await ensureComponentTable(spec)) {
    columns = await componentColumns(spec);
    // ctid identifies the row for deletion even on tables with no primary key
    rows = await sql.query(
      `SELECT ctid::text AS _ctid, * FROM ${spec.backing}
       ORDER BY ${spec.orderBy || 'ctid'} LIMIT 500`
    );
  }
  res.json({ columns, rows });
}));

app.post('/api/components/:key', requireAdmin, wrap(async (req, res) => {
  const spec = componentSpec(req.params.key);
  if (!(await ensureComponentTable(spec))) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const columns = await componentColumns(spec);
  const values = req.body?.values || {};
  const filled = columns.filter(
    (c) => !c.auto && values[c.name] !== undefined && values[c.name] !== null && values[c.name] !== ''
  );
  if (!filled.length) throw new Error('Fill in at least one field.');
  const names = filled.map((c) => `"${c.name.replaceAll('"', '')}"`).join(', ');
  const placeholders = filled.map((_, i) => `$${i + 1}`).join(', ');
  const params = filled.map((c) =>
    /int|numeric|double|real/.test(c.dataType) ? Number(values[c.name]) : String(values[c.name])
  );
  if (params.some((v) => typeof v === 'number' && !Number.isFinite(v))) {
    throw new Error('Numeric fields must contain numbers.');
  }
  await sql.query(`INSERT INTO ${spec.backing} (${names}) VALUES (${placeholders})`, params);
  await tidyIds(spec);
  res.json({ ok: true });
}));

// Bulk insert from an uploaded CSV. The client parses the file and maps its
// header onto the live columns, so what arrives here is plain row objects
// keyed by column name. The whole batch goes in as one INSERT: a bad cell
// rejects the upload instead of leaving it half applied.
const MAX_IMPORT_ROWS = 1000;

app.post('/api/components/:key/import', requireAdmin, wrap(async (req, res) => {
  const spec = componentSpec(req.params.key);
  if (!(await ensureComponentTable(spec))) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw new Error('No rows to import.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`Too many rows — import at most ${MAX_IMPORT_ROWS} at a time.`);
  }
  const columns = await componentColumns(spec);
  const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
  // Only columns the file actually fills get written; the rest keep their
  // defaults rather than being overwritten with nulls.
  const used = columns.filter((c) => !c.auto && rows.some((r) => !isBlank(r?.[c.name])));
  if (!used.length) throw new Error('None of the CSV columns match this table.');

  const params = [];
  const tuples = rows.map((row, i) => {
    const cells = used.map((c) => {
      const raw = row?.[c.name];
      // A blank cell in a column with a default takes the default (rec-del
      // pairings' Pipeline/DUNS are NOT NULL with one); otherwise NULL.
      if (isBlank(raw)) return c.hasDefault ? 'DEFAULT' : 'NULL';
      if (/int|numeric|double|real/.test(c.dataType)) {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new Error(`Row ${i + 1}: "${c.name}" must be a number — got "${raw}".`);
        }
        params.push(n);
      } else {
        params.push(String(raw).trim());
      }
      return `$${params.length}`;
    });
    return `(${cells.join(', ')})`;
  });

  const names = used.map((c) => `"${c.name.replaceAll('"', '')}"`).join(', ');
  await sql.query(
    `INSERT INTO ${spec.backing} (${names}) VALUES ${tuples.join(', ')}`,
    params
  );
  await tidyIds(spec);
  res.json({ ok: true, inserted: rows.length, columns: used.map((c) => c.name) });
}));

// Inline cell edits from the grid — update one row (found by ctid) in place.
// Note ctids change on UPDATE, so the client refetches after every save.
app.put('/api/components/:key', requireAdmin, wrap(async (req, res) => {
  const spec = componentSpec(req.params.key);
  const ctid = String(req.body?.ctid || '');
  if (!/^\(\d+,\d+\)$/.test(ctid)) throw new Error('Bad row id.');
  if (!(await ensureComponentTable(spec))) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const columns = await componentColumns(spec);
  const values = req.body?.values || {};
  const sets = columns.filter((c) => !c.auto && values[c.name] !== undefined);
  if (!sets.length) throw new Error('Nothing to update.');
  const assignments = sets
    .map((c, i) => `"${c.name.replaceAll('"', '')}" = $${i + 1}`)
    .join(', ');
  const params = sets.map((c) => {
    const v = values[c.name];
    if (v === null || v === '') return null;
    return /int|numeric|double|real/.test(c.dataType) ? Number(v) : String(v);
  });
  if (params.some((v) => typeof v === 'number' && !Number.isFinite(v))) {
    throw new Error('Numeric fields must contain numbers.');
  }
  await sql.query(
    `UPDATE ${spec.backing} SET ${assignments} WHERE ctid = $${sets.length + 1}::tid`,
    [...params, ctid]
  );
  res.json({ ok: true });
}));

app.delete('/api/components/:key', requireAdmin, wrap(async (req, res) => {
  const spec = componentSpec(req.params.key);
  const ctid = String(req.body?.ctid || '');
  if (!/^\(\d+,\d+\)$/.test(ctid)) throw new Error('Bad row id.');
  await sql.query(`DELETE FROM ${spec.backing} WHERE ctid = $1::tid`, [ctid]);
  await tidyIds(spec);
  res.json({ ok: true });
}));

// ---------- Configure Source ----------
// Which upstream API the workflow's source JSONs come from. A single-row
// setting (public.source_config) picked in Configure Components, plus one
// credentials row per source (public.source_credentials) so someone can enter
// their NatGasHub / Cortex access from the app and have it verified. For now
// this is configuration only — retrieval still runs against the mock NGH API
// until the other sources are wired to read this setting.
const SOURCE_OPTIONS = [
  {
    key: 'mockup-natgashub',
    label: 'Mock-Up NatGasHub',
    description: 'The mock NatGasHub API — same feed shapes, generated JSON',
    needsCredentials: false,
  },
  {
    key: 'natgashub',
    label: 'NatGasHub',
    description: 'Live NatGasHub API — the real gTran, gExchange and Index of Customers feeds',
    needsCredentials: true,
    healthPath: '/api/firms', // same shape as the mock — a cheap authenticated GET
  },
  {
    key: 'cortex',
    label: 'Cortex',
    description: 'Cortex API — source the feed JSONs from Cortex',
    needsCredentials: true,
    healthPath: '',
  },
];
const SOURCE_KEYS = new Set(SOURCE_OPTIONS.map((o) => o.key));
const DEFAULT_SOURCE = 'mockup-natgashub';
const sourceOption = (key) => {
  const opt = SOURCE_OPTIONS.find((o) => o.key === key);
  if (!opt) throw new Error('Unknown source.');
  return opt;
};

let sourceConfigEnsured = false;
async function ensureSourceConfig() {
  if (sourceConfigEnsured) return true;
  try {
    await sql.query(
      `CREATE TABLE IF NOT EXISTS public.source_config (
        id integer PRIMARY KEY CHECK (id = 1),
        source text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
    );
    await sql.query(
      `INSERT INTO public.source_config (id, source) VALUES (1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_SOURCE]
    );
    await sql.query(
      `CREATE TABLE IF NOT EXISTS public.source_credentials (
        source        text PRIMARY KEY,
        base_url      text NOT NULL,
        username      text,
        api_key       text,
        status        text,
        status_detail text,
        verified_at   timestamptz,
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`
    );
    sourceConfigEnsured = true;
    return true;
  } catch {
    return false;
  }
}

// What the client may see about a source's stored credentials — never the key.
const connectionSummary = (row) => ({
  configured: Boolean(row),
  status: row?.status || null,
  detail: row?.status_detail || null,
  verifiedAt: row?.verified_at || null,
  baseUrl: row?.base_url || '',
  username: row?.username || '',
  hasKey: Boolean(row?.api_key),
});

// Ping the source API with the stored credentials. Basic auth when a username
// is given, otherwise the key rides as both Bearer and x-api-key — covering
// the common schemes without knowing each API's exact one up front.
async function verifySourceApi(opt, { base_url, username, api_key }) {
  const headers = { Accept: 'application/json' };
  if (username) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${api_key || ''}`).toString('base64')}`;
  } else if (api_key) {
    headers.Authorization = `Bearer ${api_key}`;
    headers['x-api-key'] = api_key;
  }
  const url = base_url.replace(/\/+$/, '') + (opt.healthPath || '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const resp = await fetch(url, { headers, signal: ctl.signal });
    if (resp.ok) return { ok: true, detail: `API responded (HTTP ${resp.status})` };
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, detail: `credentials rejected (HTTP ${resp.status})` };
    }
    return { ok: false, detail: `reachable but returned HTTP ${resp.status} — check the base URL` };
  } catch {
    return { ok: false, detail: 'API unreachable — check the base URL' };
  } finally {
    clearTimeout(timer);
  }
}

// Run a verification for one source's stored row and persist the outcome.
async function verifyAndStore(opt, row) {
  const result = await verifySourceApi(opt, row);
  const [updated] = await sql`
    UPDATE source_credentials
    SET status = ${result.ok ? 'connected' : 'failed'},
        status_detail = ${result.detail},
        verified_at = now()
    WHERE source = ${opt.key}
    RETURNING *`;
  return updated;
}

app.get('/api/source-config', requireAdmin, wrap(async (req, res) => {
  let source = DEFAULT_SOURCE;
  let credRows = [];
  if (await ensureSourceConfig()) {
    const [row] = await sql`SELECT source FROM source_config WHERE id = 1`;
    if (row && SOURCE_KEYS.has(row.source)) source = row.source;
    credRows = await sql`SELECT * FROM source_credentials`;
  }
  const byKey = Object.fromEntries(credRows.map((r) => [r.source, r]));
  const options = SOURCE_OPTIONS.map(({ healthPath, ...opt }) => ({
    ...opt,
    connection: opt.needsCredentials ? connectionSummary(byKey[opt.key]) : null,
  }));
  res.json({ source, options });
}));

app.put('/api/source-config', requireAdmin, wrap(async (req, res) => {
  const source = String(req.body?.source || '');
  if (!SOURCE_KEYS.has(source)) throw new Error('Unknown source.');
  if (!(await ensureSourceConfig())) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  await sql`
    INSERT INTO source_config (id, source) VALUES (1, ${source})
    ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, updated_at = now()`;
  res.json({ ok: true, source });
}));

// Save (or update) one source's credentials, then verify them immediately.
// A blank api key on update keeps the stored one, so editing the base URL
// doesn't force re-entering the secret.
app.put('/api/source-config/:key/credentials', requireAdmin, wrap(async (req, res) => {
  const opt = sourceOption(req.params.key);
  if (!opt.needsCredentials) throw new Error(`${opt.label} does not take credentials.`);
  if (!(await ensureSourceConfig())) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const baseUrl = String(req.body?.baseUrl || '').trim();
  const username = String(req.body?.username || '').trim();
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    throw new Error('Enter the API base URL, starting with http:// or https://.');
  }
  const [existing] = await sql`SELECT * FROM source_credentials WHERE source = ${opt.key}`;
  if (!apiKey && !existing?.api_key && !username) {
    throw new Error('Enter an API key (or a username and password).');
  }
  const [row] = await sql`
    INSERT INTO source_credentials (source, base_url, username, api_key)
    VALUES (${opt.key}, ${baseUrl}, ${username || null}, ${apiKey || existing?.api_key || null})
    ON CONFLICT (source) DO UPDATE
    SET base_url = EXCLUDED.base_url,
        username = EXCLUDED.username,
        api_key = EXCLUDED.api_key,
        updated_at = now()
    RETURNING *`;
  const verified = await verifyAndStore(opt, row);
  res.json({ connection: connectionSummary(verified) });
}));

// Re-run the connection check — stored credentials for the real sources; the
// mock is pinged directly at SOURCE_API_BASE (nothing stored or needed).
app.post('/api/source-config/:key/verify', requireAdmin, wrap(async (req, res) => {
  const opt = sourceOption(req.params.key);
  if (!opt.needsCredentials) {
    const result = await verifySourceApi({ healthPath: '/api/firms' }, { base_url: SOURCE_API_BASE });
    const detail = !result.ok && result.detail.includes('unreachable')
      ? `mock API unreachable at ${SOURCE_API_BASE} — is it running?`
      : result.detail;
    return res.json({
      connection: {
        configured: false,
        status: result.ok ? 'connected' : 'failed',
        detail,
        verifiedAt: new Date().toISOString(),
        baseUrl: SOURCE_API_BASE,
        username: '',
        hasKey: false,
      },
    });
  }
  if (!(await ensureSourceConfig())) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const [row] = await sql`SELECT * FROM source_credentials WHERE source = ${opt.key}`;
  if (!row) throw new Error(`No credentials saved for ${opt.label} yet.`);
  const verified = await verifyAndStore(opt, row);
  res.json({ connection: connectionSummary(verified) });
}));

// Forget a source's credentials entirely.
app.delete('/api/source-config/:key/credentials', requireAdmin, wrap(async (req, res) => {
  const opt = sourceOption(req.params.key);
  if (await ensureSourceConfig()) {
    await sql`DELETE FROM source_credentials WHERE source = ${opt.key}`;
  }
  res.json({ ok: true });
}));

// ---------- Scenarios ----------
// Named run configurations created on the dashboard and attached to
// workflows there. A scenario pins one choice per reference data point
// (source, pipeline, shipper, location, rec-del pairing) in its jsonb
// config, picked from dropdowns fed by the live reference tables.
const SCENARIO_FIELDS = ['source', 'pipeline', 'shipper', 'location', 'pairing'];

let scenariosEnsured = false;
async function ensureScenarios() {
  if (scenariosEnsured) return true;
  try {
    await sql.query(
      `CREATE TABLE IF NOT EXISTS public.scenarios (
        id serial PRIMARY KEY,
        name text NOT NULL,
        description text,
        config jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    );
    await sql.query(`ALTER TABLE public.scenarios ADD COLUMN IF NOT EXISTS config jsonb`);
    scenariosEnsured = true;
    return true;
  } catch {
    return false;
  }
}

app.get('/api/scenarios', requireAdmin, wrap(async (req, res) => {
  let scenarios = [];
  if (await ensureScenarios()) {
    scenarios = await sql`SELECT * FROM scenarios ORDER BY id`;
  }
  res.json({ scenarios });
}));

// Dropdown choices for a scenario, one list per reference data point,
// compiled from the live reference tables (and the source option list).
// Which Bronze columns carry the pipeline (TSP) and the shipper (K-holder) on
// each feed, so a scenario can map one to the other. Mirrors PIPELINE_KEYS and
// ShipperMapping.keys in the pipeline repo: a feed absent here simply
// contributes no mapping, which is why Awards and IOC (no TSP identity on the
// record) are not listed.
const FEED_TSP_SHIPPER_COLUMNS = {
  'bronze.gtran_firm': {
    duns: 'tspduns', tspname: 'tspname', shipper: 'kholder', shippername: 'kholdername',
  },
  'bronze.gtran_it': {
    duns: 'tspduns', tspname: 'tspname', shipper: 'kholder', shippername: 'kholdername',
  },
};

/**
 * pipeline DUNS -> the shipper option labels that appear on its contracts.
 *
 * The relationship is not reference data anybody maintains — it exists only on
 * the contracts themselves (tspduns alongside kholder). Reading it live off
 * Bronze was too fragile: Bronze is wiped and reloaded routinely, and a
 * scenario is a PLANNING artifact that has to work BEFORE a load, so a mapping
 * that vanishes with the contracts is useless exactly when it is needed.
 *
 * So it is LEARNED and KEPT. Every time the panel loads, whatever pairs Bronze
 * currently holds are folded into public.pipeline_shipper_map; the map is then
 * what answers the question. Once a pipeline's contracts have been seen even
 * once, picking it fills in its shippers forever, wipe or no wipe.
 *
 * Labels still come from public.shipping, matching the `shipper` options
 * EXACTLY, because the client selects dropdown values with them — a remembered
 * K-holder with no row in the shipping table is left out rather than offered as
 * something the dropdown cannot represent.
 */
const ENSURE_SHIPPER_MAP = `
  CREATE TABLE IF NOT EXISTS public.pipeline_shipper_map (
    tspduns     text NOT NULL,
    tspname     text,
    kholder     text NOT NULL,
    kholdername text,
    seen_ts     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tspduns, kholder)
  )`;

async function pipelineShipperMap() {
  await sql.query(ENSURE_SHIPPER_MAP);

  // Learn from whatever is loaded right now. Empty feeds contribute nothing
  // and, crucially, remove nothing — this only ever adds.
  for (const [table, cols] of Object.entries(FEED_TSP_SHIPPER_COLUMNS)) {
    try {
      await sql.query(
        `INSERT INTO public.pipeline_shipper_map (tspduns, tspname, kholder, kholdername)
         SELECT DISTINCT btrim(b.${cols.duns}), b.${cols.tspname},
                btrim(b.${cols.shipper}), b.${cols.shippername}
         FROM ${table} b
         WHERE btrim(coalesce(b.${cols.duns}, '')) <> ''
           AND btrim(coalesce(b.${cols.shipper}, '')) <> ''
         ON CONFLICT (tspduns, kholder) DO UPDATE
           SET tspname = EXCLUDED.tspname,
               kholdername = EXCLUDED.kholdername,
               seen_ts = now()`
      );
    } catch {
      // Feed table absent — contributes no pairs.
    }
  }

  const rows = await sql.query(
    `SELECT m.tspduns AS duns, s."KHolderName" AS name, s."KHolderNo" AS no
     FROM public.pipeline_shipper_map m
     JOIN public.shipping s ON btrim(s."KHolderNo") = btrim(m.kholder)`
  );
  const map = {};
  for (const r of rows) {
    const label = r.no ? `${r.name} (${r.no})` : r.name;
    if (!label) continue;
    (map[r.duns] ||= []);
    if (!map[r.duns].includes(label)) map[r.duns].push(label);
  }
  for (const duns of Object.keys(map)) map[duns].sort();
  return map;
}

app.get('/api/scenario-options', requireAdmin, wrap(async (req, res) => {
  const grab = async (key, query, toLabel) => {
    try {
      if (!(await ensureComponentTable(COMPONENT_TABLES[key]))) return [];
      return [...new Set((await sql.query(query)).map(toLabel).filter(Boolean))];
    } catch {
      return [];
    }
  };
  res.json({
    options: {
      source: SOURCE_OPTIONS.map((o) => o.label),
      pipeline: await grab(
        'pipeline-attributes',
        `SELECT DISTINCT "Pipeline" AS name, "DUNS" AS duns FROM public.pipeline_attributes
         WHERE "Pipeline" IS NOT NULL ORDER BY 1`,
        (r) => (r.duns ? `${r.name} (${r.duns})` : r.name)
      ),
      shipper: await grab(
        'shipping',
        `SELECT "KHolderName" AS name, "KHolderNo" AS no FROM public.shipping
         WHERE "KHolderName" IS NOT NULL ORDER BY 1`,
        (r) => (r.no ? `${r.name} (${r.no})` : r.name)
      ),
      location: await grab(
        'location-purpose-code',
        `SELECT "Pipeline" AS p, "Loc_QTI" AS q, "StandardizedLocPurp" AS s
         FROM public.location_purpose_code ORDER BY id`,
        (r) => [r.p, r.q, r.s].filter(Boolean).join(' — ')
      ),
      pairing: await grab(
        'rec-del-pairings',
        `SELECT "Order" AS ord, "Pattern" AS pat, "Pipeline" AS p
         FROM public.rec_del_pairings ORDER BY "Order", id`,
        (r) => `${r.ord != null ? `${r.ord}. ` : ''}${r.pat || ''}${r.p ? ` (${r.p})` : ''}`.trim()
      ),
    },
    // Pipeline DUNS -> its contracts' shipper labels, so picking a pipeline in
    // a scenario can fill in the shippers that actually trade on it.
    pipelineShippers: await pipelineShipperMap().catch(() => ({})),
  });
}));

// Keep only the known reference points; each holds one or more values (a lone
// string is accepted and folded into a one-element array). Shared by create and
// update so the two can never validate a scenario differently.
function normalizeScenarioConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const config = {};
  for (const f of SCENARIO_FIELDS) {
    const arr = Array.isArray(raw[f]) ? raw[f] : typeof raw[f] === 'string' ? [raw[f]] : [];
    const vals = [
      ...new Set(
        arr.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim().slice(0, 300))
      ),
    ].slice(0, 50);
    if (vals.length) config[f] = vals;
  }
  return Object.keys(config).length ? config : null;
}

app.post('/api/scenarios', requireAdmin, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!name) throw new Error('Scenario name is required.');
  const config = normalizeScenarioConfig(req.body?.config);
  if (!(await ensureScenarios())) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const [scenario] = await sql`
    INSERT INTO scenarios (name, description, config)
    VALUES (${name}, ${description || null}, ${config ? JSON.stringify(config) : null}::jsonb)
    RETURNING *`;
  res.json({ scenario });
}));

// Edit a scenario IN PLACE. Keeping the id is the whole point: workflows
// reference a scenario by id, so editing must not orphan them the way
// delete-then-recreate would (a new row gets a new id, and the workflow's
// dispatch then fails with "the attached scenario no longer exists").
app.put('/api/scenarios/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new Error('Bad scenario id.');
  const name = String(req.body?.name || '').trim();
  if (!name) throw new Error('Scenario name is required.');
  const description = String(req.body?.description || '').trim();
  const config = normalizeScenarioConfig(req.body?.config);
  if (!(await ensureScenarios())) {
    throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
  }
  const [scenario] = await sql`
    UPDATE scenarios
    SET name = ${name},
        description = ${description || null},
        config = ${config ? JSON.stringify(config) : null}::jsonb
    WHERE id = ${id}
    RETURNING *`;
  if (!scenario) {
    throw new Error(`Scenario ${id} no longer exists — it may have been deleted in another tab.`);
  }
  res.json({ scenario });
}));

app.delete('/api/scenarios/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new Error('Bad scenario id.');
  if (await ensureScenarios()) {
    await sql`DELETE FROM scenarios WHERE id = ${id}`;
  }
  res.json({ ok: true });
}));

// ---------- Pipeline filter options ----------
// Distinct pipeline (TSP) names per source, for the workflow "Configure
// Components" picker. Prefers pinging the live source API; falls back to the
// warehouse's bronze rows when the mock isn't running.
// Per-feed source path plus which columns carry the pipeline (TSP) identity —
// gTran feeds use tspname/tspduns, awards spells it out in full.
const SOURCE_PIPELINES = {
  firm: { path: '/api/firms', name: 'tspname', duns: 'tspduns' },
  interruptible: { path: '/api/interruptibles', name: 'tspname', duns: 'tspduns' },
  awards: { path: '/api/awards', name: 'transportationserviceprovidername', duns: null },
  index: { path: '/api/ioc', name: 'pipe', duns: null }, // IOC calls the pipeline 'Pipe'
};

// Case-insensitive field lookup — the live API uses TitleCase (TspName), the
// bronze tables lowercase everything (tspname).
const pickField = (record, ...names) => {
  const lower = Object.fromEntries(Object.keys(record).map((k) => [k.toLowerCase(), record[k]]));
  for (const n of names) {
    const v = n && lower[n.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};
const SOURCE_API_BASE = process.env.SOURCE_API_BASE || 'http://localhost:8000';

app.get('/api/pipeline-options', requireAdmin, wrap(async (req, res) => {
  const wanted = String(req.query.sources || '').split(',').filter((k) => SOURCE_PIPELINES[k]);
  const options = {};
  await Promise.all(wanted.map(async (key) => {
    // 1. the live source API for this feed
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const resp = await fetch(`${SOURCE_API_BASE}${SOURCE_PIPELINES[key].path}`, { signal: ctl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const body = await resp.json();
        // records may sit at the top level or under a wrapper key
        // (contracts, awards, data, ...) — take the first array we find
        const records = Array.isArray(body)
          ? body
          : Object.values(body).find(Array.isArray) || [];
        const spec = SOURCE_PIPELINES[key];
        const seen = new Map();
        for (const r of records) {
          const name = pickField(r, spec.name, 'tspname', 'transportationserviceprovidername');
          if (name && !seen.has(name))
            seen.set(name, { name, duns: pickField(r, spec.duns, 'tspduns') });
        }
        if (seen.size) {
          options[key] = {
            from: 'source-api',
            pipelines: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
          };
          return;
        }
      }
    } catch {
      // source API unreachable — fall through to the warehouse
    }
    // 2. what the warehouse has already ingested for this feed
    try {
      const backing = provider.feeds[key]?.tables?.bronze?.table;
      const spec = SOURCE_PIPELINES[key];
      if (!backing) throw new Error('no bronze table');
      options[key] = {
        from: 'warehouse',
        pipelines: await sql.query(
          `SELECT DISTINCT ${spec.name} AS name, ${spec.duns || 'NULL'} AS duns
           FROM ${backing} WHERE ${spec.name} IS NOT NULL ORDER BY 1`
        ),
      };
    } catch {
      options[key] = { from: 'none', pipelines: [] };
    }
  }));
  res.json({ options });
}));

// ---------- Power BI ----------
// AAD token for the embedded quick-create canvas. Handing the service
// principal's token to the browser is acceptable for this internal tool; the
// principal only has rights on the PAP Analytics workspace.
app.get('/api/powerbi/token', requireAdmin, wrap(async (req, res) => {
  if (!powerbiConfigured) {
    return res.status(503).json({
      error: 'Power BI is not configured on the server — set the POWERBI_* values in server/.env.',
    });
  }
  const { accessToken, expiresAt } = await powerbiAadToken();
  res.json({ accessToken, expiresAt, workspaceId: process.env.POWERBI_WORKSPACE_ID });
}));

// Push the current gold view into a workspace dataset and hand back an embed
// token for a report-creation canvas over it. Service-principal-safe, unlike
// quickCreate (which only works with user AAD tokens).
app.post('/api/powerbi/gold-report', requireAdmin, wrap(async (req, res) => {
  if (!powerbiConfigured) {
    return res.status(503).json({
      error: 'Power BI is not configured on the server — set the POWERBI_* values in server/.env.',
    });
  }
  const { modelName, columns, rows } = req.body || {};
  if (!modelName || !Array.isArray(columns) || !columns.length || !Array.isArray(rows)) {
    throw new Error('modelName, columns and rows are required.');
  }
  res.json(await goldReportEmbed({ modelName, columns, rows }));
}));

// ---------- Pipeline ----------
app.post('/api/pipeline/retrieve-source', requireAdmin, wrap(async (req, res) => {
  res.json(await retrieveSource(req.body?.source, req.body?.batchId));
}));

app.post('/api/pipeline/stage/:n', requireAdmin, wrap(async (req, res) => {
  const n = Number(req.params.n);
  res.json(await runStage(n, req.body?.batchId));
}));

// Dispatch each selected source's end-to-end pipeline workflow (stages 1-5
// in one run per feed) on the STAGE_3_4_5 repo. Route path kept for the client.
// The workflow's attached scenario is applied FIRST, as the pipeline's shipper
// scope (bronze.shipper_mapping), so the dispatched stage-3 runs read it —
// no scenario clears the scope, keeping every run reproducible from its
// scenario alone.
app.post('/api/pipeline/trigger-stage12', requireAdmin, wrap(async (req, res) => {
  const scope = await applyScenarioScope(req.body?.scenarioId);
  // The scenario's Pipeline picks become the run's ONBOARDING REGISTER: a
  // contract whose TSP is not in it is held back at deduplication(p1) and
  // reported, while registered pipelines in the same load process normally.
  const pipelines = await applyScenarioPipelines(req.body?.scenarioId);
  res.json({ ...(await triggerPipeline(req.body?.sources)), scope, pipelines });
}));

// Dispatch one source's ingest-only (stage 1-2) workflow — Manual Workflow panel
app.post('/api/pipeline/trigger-ingest', requireAdmin, wrap(async (req, res) => {
  res.json(await triggerIngest(req.body?.source));
}));

// Live status of a dispatch (?files=a.yml,b.yml&since=ISO): one run per file,
// with its jobs — stages 3-5 are jobs inside each feed's run now.
//
// Add &writes=1 to also read each job's log for the run's WRITE SEMANTICS —
// which tables were appended to, preserved, rebuilt or skipped, and how many
// rows each moved. That is the part a bare "completed" hides: rerunning a
// workflow rebuilds every downstream table whether or not anything new came
// in, and only the amendments ledger carries state between runs.
app.get('/api/pipeline/run-status', requireAdmin, wrap(async (req, res) => {
  const files = String(req.query.files || '').split(',').filter(Boolean);
  const withWrites = req.query.writes === '1';
  res.json(await pipelineRunStatus(files, req.query.since, { withWrites }));
}));

// Cancel the in-flight GitHub Actions runs of a dispatch ({ files, since })
app.post('/api/pipeline/cancel-run', requireAdmin, wrap(async (req, res) => {
  res.json(await cancelPipelineRuns(req.body?.files, req.body?.since));
}));

// ---------- Workflows ----------
app.get('/api/workflows', requireAdmin, wrap(async (req, res) => {
  try {
    const workflows = await sql`SELECT * FROM workflows ORDER BY id`;
    const runs = await sql`
      SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 20`;
    res.json({ workflows, runs });
  } catch {
    // No database — show the default workflow so the panel still renders
    res.json({
      workflows: [{
        id: 1,
        name: 'Full Pipeline',
        description: 'Retrieve source then run Stages 1-5 end to end',
        schedule_minutes: null,
        enabled: false,
        last_run_at: null,
      }],
      runs: [],
    });
  }
}));

app.post('/api/workflows/:id/run', requireAdmin, wrap(async (req, res) => {
  res.json(await runFullPipeline(Number(req.params.id)));
}));

app.put('/api/workflows/:id/schedule', requireAdmin, wrap(async (req, res) => {
  const { scheduleMinutes, enabled } = req.body;
  const minutes = scheduleMinutes === null || scheduleMinutes === '' ? null : Number(scheduleMinutes);
  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 1)) {
    throw new Error('Schedule must be at least 1 minute.');
  }
  const [workflow] = await sql`
    UPDATE workflows
    SET schedule_minutes = ${minutes}, enabled = ${!!enabled && minutes !== null}
    WHERE id = ${Number(req.params.id)}
    RETURNING *`;
  if (!workflow) throw new Error('Workflow not found.');
  await reloadSchedules();
  res.json({ workflow });
}));

// On Vercel the app is exported and served by api/[[...path]].js — no listener,
// and no interval scheduler (serverless invocations don't stay alive between
// requests, so timers would never fire; run schedules locally or via a cron).
export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, async () => {
    console.log(`interface-pap API listening on http://localhost:${port}`);
    try {
      await reloadSchedules();
    } catch (err) {
      console.error('Could not load schedules (is the database initialized?):', err.message);
    }
  });
}
