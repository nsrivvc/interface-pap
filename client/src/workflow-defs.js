// Shared workflow definitions: which NGH sources a workflow can retrieve
// (Stage 1) and which transformation stages it can run (Stages 2-5).
// Used by the dashboard's WorkflowPanel and the Table Viewer.

// Stage 1 (API to Raw) is the source retrieval itself; Stages 2-5 are the
// transformations below. A workflow's stages are always a contiguous prefix
// of this list — you can't run Stage 3 without Stage 2. `apiStage` is the
// pipeline stage number on the server.
export const STAGE_DEFS = [
  { key: 2, apiStage: 1, label: 'Stage 2', desc: 'JSON-Bronze' },
  { key: 3, apiStage: 2, label: 'Stage 3', desc: 'Silver Staging (Bronze-To-Silver)' },
  { key: 4, apiStage: 3, label: 'Stage 4', desc: 'Rec-Del Pairing' },
  { key: 5, apiStage: 4, label: 'Stage 5', desc: 'Master Capacity' },
];

// NGH API pipelines the workflow retrieves before its stages run
export const SOURCE_DEFS = [
  { key: 'firm', label: 'Firm', desc: 'NGH-gTran-Firms-API-Pipeline' },
  { key: 'interruptible', label: 'Interruptible', desc: 'NGH-gTran-Interruptibles-API-Pipeline' },
  { key: 'awards', label: 'Awards', desc: 'NGH-gExchange-Awards-API-Pipeline' },
  { key: 'index', label: 'Index of Customers', desc: 'NGH-IndexOfCustomers-API-Pipeline' },
];

export const ALL_SOURCE_KEYS = SOURCE_DEFS.map((s) => s.key);
export const sourceLabel = (key) => SOURCE_DEFS.find((s) => s.key === key)?.label || key;

// Compact source names for badges/chips on workflow cards
const SOURCE_SHORT = { firm: 'Firm', interruptible: 'IT', awards: 'Awards', index: 'IOC' };
export const shortSourceLabel = (key) => SOURCE_SHORT[key] || key;

export const STORAGE_KEY = 'pap_workflows_v2';

export function loadWorkflows() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    // Clamp older saves to the current stage blocks and source list
    return stored.map((w) => {
      const sources = (w.sources || []).filter((k) => ALL_SOURCE_KEYS.includes(k));
      return {
        ...w,
        stageCount: Math.min(w.stageCount, STAGE_DEFS.length),
        sources: sources.length ? sources : ALL_SOURCE_KEYS,
      };
    });
  } catch {
    return [];
  }
}

export function saveWorkflows(workflows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows));
}

// Stage 3 standardized tables per retrieved source — each source has
// Locations, Core and Rates tables. IOC (index) stops after Stage 2, so it
// contributes no tables from here on.
export const STAGE3_SOURCE_TABLES = {
  firm: ['firm_locations_standardized', 'firm_core_standardized', 'firm_rates_standardized'],
  interruptible: [
    'interruptible_locations_standardized',
    'interruptible_core_standardized',
    'interruptible_rates_standardized',
  ],
  awards: ['awards_locations_standardized', 'awards_core_standardized', 'awards_rates_standardized'],
  index: [],
};

// Stage 4 rec-del paired tables per retrieved source
export const STAGE4_SOURCE_TABLES = {
  firm: ['firm_locations_standardized_transformed'],
  interruptible: ['interruptible_locations_standardized_transformed'],
  awards: ['awards_locations_standardized_transformed'],
  index: [],
};

// Stage 5 master capacity tables per retrieved source, plus the Final
// tables every workflow that reaches Stage 5 gets.
export const STAGE5_SOURCE_TABLES = {
  firm: ['firm_core_master_capacity', 'firm_locations_master_capacity', 'firm_rates_master_capacity'],
  interruptible: [
    'interruptible_core_master_capacity',
    'interruptible_locations_master_capacity',
    'interruptible_rates_master_capacity',
  ],
  awards: ['awards_core_master_capacity', 'awards_locations_master_capacity', 'awards_rates_master_capacity'],
  index: [],
};
const STAGE5_FINAL_TABLES = [
  'final_core_master_capacity',
  'final_locations_master_capacity',
  'final_rates_master_capacity',
];

// Table Viewer table names for each part of a workflow. Stages 1-5
// have tables per retrieved source; Stage 5 adds the Final tables.
const STAGE_TABLES = {
  3: ALL_SOURCE_KEYS.flatMap((k) => STAGE3_SOURCE_TABLES[k]),
  4: ALL_SOURCE_KEYS.flatMap((k) => STAGE4_SOURCE_TABLES[k]),
  5: [...ALL_SOURCE_KEYS.flatMap((k) => STAGE5_SOURCE_TABLES[k]), ...STAGE5_FINAL_TABLES],
};

const STAGE_ICONS = { 1: '{ }', 2: '✓', 3: '≡', 4: '+', 5: 'Σ' };

/**
 * The stage sections of a workflow for the Table Viewer:
 * Stage 1 raw tables for its sources, then one section per selected stage.
 */
export function workflowStageSections(wf) {
  const sections = [
    {
      key: 1,
      title: 'Stage 1 — API to Raw',
      icon: STAGE_ICONS[1],
      tables: wf.sources.map((k) => `raw_${k}`),
    },
  ];
  for (const stage of STAGE_DEFS.slice(0, wf.stageCount)) {
    sections.push({
      key: stage.key,
      title: `${stage.label} — ${stage.desc}`,
      icon: STAGE_ICONS[stage.key],
      tables:
        stage.key === 2
          ? wf.sources.map((k) => `bronze_${k}`)
          : stage.key === 3
            ? wf.sources.flatMap((k) => STAGE3_SOURCE_TABLES[k])
            : stage.key === 4
              ? wf.sources.flatMap((k) => STAGE4_SOURCE_TABLES[k])
              : stage.key === 5
                ? [
                    ...wf.sources.flatMap((k) => STAGE5_SOURCE_TABLES[k]),
                    ...STAGE5_FINAL_TABLES,
                  ]
                : STAGE_TABLES[stage.key],
    });
  }
  return sections;
}
