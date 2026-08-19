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
import { provider, FEED_KEYS, feedSummaries } from './providers/index.js';

const app = express();
app.use(cors());
app.use(express.json());

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
  const counts = {}; // backing table -> row count, queried once each
  for (const backing of new Set(Object.values(TABLE_INDEX).map((t) => t.backing))) {
    try {
      const [{ count }] = await sql.query(`SELECT count(*)::int AS count FROM ${backing}`);
      counts[backing] = count;
    } catch {
      counts[backing] = 0; // no database yet
    }
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
