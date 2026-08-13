import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { sql } from './db.js';
import { signToken, requireAuth } from './auth.js';
import { retrieveSource, runStage, runFullPipeline } from './pipeline.js';
import { reloadSchedules } from './scheduler.js';
import { registerDownloadRoute } from './downloads.js';
import { triggerStage12, pipelineRunStatus } from './github.js';

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
// Each pipeline stage owns a set of tables. `backing` is the physical
// Postgres table the virtual table reads from until the real per-source
// tables exist in Neon.
const STAGE_TABLES = [
  // The raw tables read the real Bronze tables the ingestion workflows load
  // into Neon (bronze schema, one table per source feed).
  {
    stage: 'Stage 1 — API to Raw',
    tables: [
      { name: 'raw_firm', label: 'Firm Raw Table', backing: 'bronze.gtran_firm', orderBy: 'bronze_row_id' },
      { name: 'raw_interruptible', label: 'Interruptible Raw Table', backing: 'bronze.gtran_it', orderBy: 'bronze_row_id' },
      { name: 'raw_awards', label: 'Awards Raw Table', backing: 'bronze.gawd', orderBy: 'bronze_row_id' },
      { name: 'raw_index', label: 'Index of Customers Raw Table', backing: 'bronze.gindex', orderBy: 'bronze_row_id' },
    ],
  },
  {
    stage: 'Stage 2 — JSON-Bronze',
    tables: [
      { name: 'raw_firm', label: 'Firm Raw Table', backing: 'bronze.gtran_firm', orderBy: 'bronze_row_id' },
      { name: 'raw_interruptible', label: 'Interruptible Raw Table', backing: 'bronze.gtran_it', orderBy: 'bronze_row_id' },
      { name: 'raw_awards', label: 'Awards Raw Table', backing: 'bronze.gawd', orderBy: 'bronze_row_id' },
      { name: 'raw_index', label: 'Index of Customers Raw Table', backing: 'bronze.gindex', orderBy: 'bronze_row_id' },
    ],
  },
  // Stage 3-5 firm tables read the real Silver tables the bronze_to_silver
  // pipeline writes in Neon. Interruptible/Awards silver tables don't exist
  // yet — their backings are the expected future names, so they show 0 rows
  // until those pipelines land.
  {
    stage: 'Stage 3 — Silver Staging',
    tables: [
      { name: 'firm_locations_standardized', label: 'Firm Locations — Standardized', backing: 'silver_staging.firm_locations', orderBy: '"index"' },
      { name: 'firm_core_standardized', label: 'Firm Core — Standardized', backing: 'silver_staging.firm_core', orderBy: 'bronze_row_id' },
      { name: 'firm_rates_standardized', label: 'Firm Rates — Standardized', backing: 'silver_staging.firm_rates', orderBy: 'bronze_row_id' },
      { name: 'interruptible_locations_standardized', label: 'Interruptible Locations — Standardized', backing: 'silver_staging.interruptible_locations' },
      { name: 'interruptible_core_standardized', label: 'Interruptible Core — Standardized', backing: 'silver_staging.interruptible_core' },
      { name: 'interruptible_rates_standardized', label: 'Interruptible Rates — Standardized', backing: 'silver_staging.interruptible_rates' },
      { name: 'awards_locations_standardized', label: 'Awards Locations — Standardized', backing: 'silver_staging.awards_locations' },
      { name: 'awards_core_standardized', label: 'Awards Core — Standardized', backing: 'silver_staging.awards_core' },
      { name: 'awards_rates_standardized', label: 'Awards Rates — Standardized', backing: 'silver_staging.awards_rates' },
    ],
  },
  {
    stage: 'Stage 4 — Rec-Del Pairing',
    tables: [
      { name: 'firm_locations_standardized_transformed', label: 'Firm Locations — Standardized (Transformed)', backing: 'silver.firm_rec_del_pair', orderBy: 'rec_del_pair_id' },
      { name: 'interruptible_locations_standardized_transformed', label: 'Interruptible Locations — Standardized (Transformed)', backing: 'silver.interruptible_rec_del_pair' },
      { name: 'awards_locations_standardized_transformed', label: 'Awards Locations — Standardized (Transformed)', backing: 'silver.awards_rec_del_pair' },
    ],
  },
  {
    stage: 'Stage 5 — Master Capacity',
    tables: [
      { name: 'firm_core_master_capacity', label: 'Firm Core — Master Capacity', backing: 'silver.firm_core_master_capacity', orderBy: 'firm_core_id' },
      { name: 'firm_locations_master_capacity', label: 'Firm Locations — Master Capacity', backing: 'silver.firm_locations_master_capacity', orderBy: 'firm_locations_id' },
      { name: 'firm_rates_master_capacity', label: 'Firm Rates — Master Capacity', backing: 'silver.firm_rates_master_capacity', orderBy: 'firm_rates_id' },
      { name: 'interruptible_core_master_capacity', label: 'Interruptible Core — Master Capacity', backing: 'silver.interruptible_core_master_capacity' },
      { name: 'interruptible_locations_master_capacity', label: 'Interruptible Locations — Master Capacity', backing: 'silver.interruptible_locations_master_capacity' },
      { name: 'interruptible_rates_master_capacity', label: 'Interruptible Rates — Master Capacity', backing: 'silver.interruptible_rates_master_capacity' },
      { name: 'awards_core_master_capacity', label: 'Awards Core — Master Capacity', backing: 'silver.awards_core_master_capacity' },
      { name: 'awards_locations_master_capacity', label: 'Awards Locations — Master Capacity', backing: 'silver.awards_locations_master_capacity' },
      { name: 'awards_rates_master_capacity', label: 'Awards Rates — Master Capacity', backing: 'silver.awards_rates_master_capacity' },
      { name: 'final_core_master_capacity', label: 'Final Core — Master Capacity', backing: 'silver.final_core_master_capacity', orderBy: 'final_core_id' },
      { name: 'final_locations_master_capacity', label: 'Final Locations — Master Capacity', backing: 'silver.final_locations_master_capacity', orderBy: 'final_locations_id' },
      { name: 'final_rates_master_capacity', label: 'Final Rates — Master Capacity', backing: 'silver.final_rates_master_capacity', orderBy: 'final_rates_id' },
    ],
  },
  {
    stage: 'Logging',
    tables: [
      { name: 'workflow_runs', label: 'Workflow Run Logs', backing: 'workflow_runs' },
    ],
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

// Dispatch the Stage 1/2 GitHub Actions ingestion workflows for the selected sources
app.post('/api/pipeline/trigger-stage12', requireAuth, wrap(async (req, res) => {
  res.json(await triggerStage12(req.body?.sources));
}));

// Live status of a dispatch: ingestion runs + the Silver runs they triggered
// (?files=a.yml,b.yml&since=ISO)
app.get('/api/pipeline/run-status', requireAuth, wrap(async (req, res) => {
  const files = String(req.query.files || '').split(',').filter(Boolean);
  res.json(await pipelineRunStatus(files, req.query.since));
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
