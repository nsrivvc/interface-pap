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
      { name: 'raw_firm', label: 'Firm — Raw JSON' },
      { name: 'bronze_firm', label: 'Firm — Bronze' },
      { name: 'raw_interruptible', label: 'Interruptible — Raw JSON' },
      { name: 'bronze_interruptible', label: 'Interruptible — Bronze' },
      { name: 'raw_awards', label: 'Awards — Raw JSON' },
      { name: 'bronze_awards', label: 'Awards — Bronze' },
      { name: 'raw_index', label: 'Index of Customers — Raw JSON' },
      { name: 'bronze_index', label: 'Index of Customers — Bronze' },
    ],
  },
  {
    stage: 'Stage 3 — Silver Staging',
    tables: [
      { name: 'firm_locations_standardized', label: 'Firm Locations — Standardized' },
      { name: 'firm_core_standardized', label: 'Firm Core — Standardized' },
      { name: 'firm_rates_standardized', label: 'Firm Rates — Standardized' },
    ],
  },
  {
    stage: 'Stage 4 — Rec-Del Pairing',
    tables: [
      { name: 'firm_locations_standardized_transformed', label: 'Firm Locations — Standardized (Transformed)' },
    ],
  },
  {
    stage: 'Stage 5 — Master Capacity',
    tables: [
      { name: 'firm_core_master_capacity', label: 'Firm Core — Master Capacity' },
      { name: 'firm_locations_master_capacity', label: 'Firm Locations — Master Capacity' },
      { name: 'firm_rates_master_capacity', label: 'Firm Rates — Master Capacity' },
      { name: 'final_core_master_capacity', label: 'Final Core — Master Capacity' },
      { name: 'final_locations_master_capacity', label: 'Final Locations — Master Capacity' },
      { name: 'final_rates_master_capacity', label: 'Final Rates — Master Capacity' },
    ],
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
