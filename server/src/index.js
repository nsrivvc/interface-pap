import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { sql } from './db.js';
import { signToken, requireAuth } from './auth.js';
import { retrieveSource, runStage, runFullPipeline } from './pipeline.js';
import { reloadSchedules } from './scheduler.js';
import { registerDownloadRoute } from './downloads.js';
import { triggerPipeline, triggerIngest, pipelineRunStatus, cancelPipelineRuns } from './github.js';
import { powerbiAadToken, powerbiConfigured, goldReportEmbed } from './powerbi.js';
import { provider, FEED_KEYS, feedSummaries } from './providers/index.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' })); // gold-view rows ride in the body

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => res.status(400).json({ error: err.message }));

// ---------- Auth ----------
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) throw new Error('Name, email and password are required.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
  if (existing.length) throw new Error('An account with that email already exists.');
  const hash = await bcrypt.hash(password, 10);
  const [user] = await sql`
    INSERT INTO users (name, email, password_hash)
    VALUES (${name}, ${email.toLowerCase()}, ${hash})
    RETURNING id, name, email`;
  res.json({ token: signToken(user), user });
}));

// Local admin account — works with or without a database connection
const LOCAL_ADMIN = { id: 0, name: 'Admin', email: 'admin' };

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if ((email || '').toLowerCase() === LOCAL_ADMIN.email && password === '12345') {
    return res.json({ token: signToken(LOCAL_ADMIN), user: LOCAL_ADMIN });
  }
  const [user] = await sql`
    SELECT id, name, email, password_hash FROM users WHERE email = ${(email || '').toLowerCase()}`;
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const safe = { id: user.id, name: user.name, email: user.email };
  res.json({ token: signToken(safe), user: safe });
}));

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

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
    tables: grains(['locations', 'core', 'rates'], (f, g) =>
      vt(
        f.tables.silverStaging?.[g],
        `${f.key}_${g}_standardized`,
        `${f.label} ${CAP[g]} — Standardized`
      )
    ).filter(Boolean),
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
};
const SOURCE_API_BASE = process.env.SOURCE_API_BASE || 'http://localhost:8000';

app.get('/api/pipeline-options', requireAuth, wrap(async (req, res) => {
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
        const records = Array.isArray(body) ? body : body.data || body.results || [];
        const spec = SOURCE_PIPELINES[key];
        const seen = new Map();
        for (const r of records) {
          const name = r[spec.name] || r.tspname || r.TSPName || r.transportationserviceprovidername;
          if (name && !seen.has(name))
            seen.set(name, { name, duns: (spec.duns && r[spec.duns]) || null });
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
app.get('/api/powerbi/token', requireAuth, wrap(async (req, res) => {
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
app.post('/api/powerbi/gold-report', requireAuth, wrap(async (req, res) => {
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
app.post('/api/pipeline/retrieve-source', requireAuth, wrap(async (req, res) => {
  res.json(await retrieveSource(req.body?.source, req.body?.batchId));
}));

app.post('/api/pipeline/stage/:n', requireAuth, wrap(async (req, res) => {
  const n = Number(req.params.n);
  res.json(await runStage(n, req.body?.batchId));
}));

// Dispatch each selected source's end-to-end pipeline workflow (stages 1-5
// in one run per feed) on the STAGE_3_4_5 repo. Route path kept for the client.
app.post('/api/pipeline/trigger-stage12', requireAuth, wrap(async (req, res) => {
  res.json(await triggerPipeline(req.body?.sources));
}));

// Dispatch one source's ingest-only (stage 1-2) workflow — Manual Workflow panel
app.post('/api/pipeline/trigger-ingest', requireAuth, wrap(async (req, res) => {
  res.json(await triggerIngest(req.body?.source));
}));

// Live status of a dispatch (?files=a.yml,b.yml&since=ISO): one run per file,
// with its jobs — stages 3-5 are jobs inside each feed's run now.
app.get('/api/pipeline/run-status', requireAuth, wrap(async (req, res) => {
  const files = String(req.query.files || '').split(',').filter(Boolean);
  res.json(await pipelineRunStatus(files, req.query.since));
}));

// Cancel the in-flight GitHub Actions runs of a dispatch ({ files, since })
app.post('/api/pipeline/cancel-run', requireAuth, wrap(async (req, res) => {
  res.json(await cancelPipelineRuns(req.body?.files, req.body?.since));
}));

// ---------- Workflows ----------
app.get('/api/workflows', requireAuth, wrap(async (req, res) => {
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

app.post('/api/workflows/:id/run', requireAuth, wrap(async (req, res) => {
  res.json(await runFullPipeline(Number(req.params.id)));
}));

app.put('/api/workflows/:id/schedule', requireAuth, wrap(async (req, res) => {
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

const port = process.env.PORT || 4000;
app.listen(port, async () => {
  console.log(`interface-pap API listening on http://localhost:${port}`);
  try {
    await reloadSchedules();
  } catch (err) {
    console.error('Could not load schedules (is the database initialized?):', err.message);
  }
});
