import { requireAuth } from '../_lib.js';

// Mirrors STAGE_TABLES in server/src/index.js. No database yet, so every
// table reports zero rows.
export const STAGE_TABLES = [
  {
    stage: 'Stage 1 — API to Raw',
    tables: [
      { name: 'raw_firm', label: 'Firm Raw Table' },
      { name: 'raw_interruptible', label: 'Interruptible Raw Table' },
      { name: 'raw_awards', label: 'Awards Raw Table' },
      { name: 'raw_index', label: 'Index of Customers Raw Table' },
    ],
  },
  {
    stage: 'Stage 2 — JSON-Bronze',
    tables: [
      { name: 'raw_firm', label: 'Firm Raw Table' },
      { name: 'raw_interruptible', label: 'Interruptible Raw Table' },
      { name: 'raw_awards', label: 'Awards Raw Table' },
      { name: 'raw_index', label: 'Index of Customers Raw Table' },
    ],
  },
  {
    stage: 'Stage 3 — Silver Staging',
    tables: [
      { name: 'firm_locations_standardized', label: 'Firm Locations — Standardized' },
      { name: 'firm_core_standardized', label: 'Firm Core — Standardized' },
      { name: 'firm_rates_standardized', label: 'Firm Rates — Standardized' },
      { name: 'interruptible_locations_standardized', label: 'Interruptible Locations — Standardized' },
      { name: 'interruptible_core_standardized', label: 'Interruptible Core — Standardized' },
      { name: 'interruptible_rates_standardized', label: 'Interruptible Rates — Standardized' },
      { name: 'awards_locations_standardized', label: 'Awards Locations — Standardized' },
      { name: 'awards_core_standardized', label: 'Awards Core — Standardized' },
      { name: 'awards_rates_standardized', label: 'Awards Rates — Standardized' },
      { name: 'index_locations_standardized', label: 'IOC Locations — Standardized' },
      { name: 'index_core_standardized', label: 'IOC Core — Standardized' },
      { name: 'index_rates_standardized', label: 'IOC Rates — Standardized' },
    ],
  },
  {
    stage: 'Stage 4 — Rec-Del Pairing',
    tables: [
      { name: 'firm_locations_standardized_transformed', label: 'Firm Locations — Standardized (Transformed)' },
      { name: 'interruptible_standardized_transformed', label: 'Interruptible — Standardized (Transformed)' },
      { name: 'awards_standardized_transformed', label: 'Awards — Standardized (Transformed)' },
      { name: 'index_standardized_transformed', label: 'Index of Customers — Standardized (Transformed)' },
    ],
  },
  {
    stage: 'Stage 5 — Master Capacity',
    tables: [
      { name: 'firm_core_master_capacity', label: 'Firm Core — Master Capacity' },
      { name: 'firm_locations_master_capacity', label: 'Firm Locations — Master Capacity' },
      { name: 'firm_rates_master_capacity', label: 'Firm Rates — Master Capacity' },
      { name: 'interruptible_core_master_capacity', label: 'Interruptible Core — Master Capacity' },
      { name: 'interruptible_locations_master_capacity', label: 'Interruptible Locations — Master Capacity' },
      { name: 'interruptible_rates_master_capacity', label: 'Interruptible Rates — Master Capacity' },
      { name: 'awards_core_master_capacity', label: 'Awards Core — Master Capacity' },
      { name: 'awards_locations_master_capacity', label: 'Awards Locations — Master Capacity' },
      { name: 'awards_rates_master_capacity', label: 'Awards Rates — Master Capacity' },
      { name: 'index_core_master_capacity', label: 'IOC Core — Master Capacity' },
      { name: 'index_locations_master_capacity', label: 'IOC Locations — Master Capacity' },
      { name: 'index_rates_master_capacity', label: 'IOC Rates — Master Capacity' },
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
