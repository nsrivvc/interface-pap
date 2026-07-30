import { requireAuth } from '../_lib.js';

// Mirrors STAGE_TABLES in server/src/index.js. No database yet, so every
// table reports zero rows.
export const STAGE_TABLES = [
  {
    stage: 'Stage 1 — API to Raw',
    tables: [
      { name: 'raw_firm', label: 'Firm — Raw JSON' },
      { name: 'raw_interruptible', label: 'Interruptible — Raw JSON' },
      { name: 'raw_awards', label: 'Awards — Raw JSON' },
      { name: 'raw_index', label: 'Index of Customers — Raw JSON' },
    ],
  },
  {
    stage: 'Stage 2 — JSON-Bronze',
    tables: [
      { name: 'bronze_firm', label: 'Firm — Bronze' },
      { name: 'bronze_interruptible', label: 'Interruptible — Bronze' },
      { name: 'bronze_awards', label: 'Awards — Bronze' },
      { name: 'bronze_index', label: 'Index of Customers — Bronze' },
    ],
  },
  {
    stage: 'Stage 3 — Silver Staging',
    tables: [{ name: 'silver_staging', label: 'Capacity — Silver Staging' }],
  },
  {
    stage: 'Stage 4 — Rec-Del Pairing',
    tables: [{ name: 'rec_del_pairs', label: 'Rec-Del Pairs' }],
  },
  {
    stage: 'Stage 5 — Master Capacity',
    tables: [{ name: 'master_capacity', label: 'Master Capacity' }],
  },
  {
    stage: 'Logging',
    tables: [{ name: 'workflow_runs', label: 'Workflow Run Logs' }],
  },
  {
    stage: 'Exceptions',
    tables: [{ name: 'pipeline_exceptions', label: 'Pipeline Exceptions' }],
  },
];

export default function handler(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  const stages = STAGE_TABLES.map((s) => ({
    stage: s.stage,
    tables: s.tables.map((t) => ({ ...t, rowCount: 0 })),
  }));
  res.json({ stages });
}
