import { FEEDS } from './providers/index.js';

// Shared workflow definitions: which sources a workflow can retrieve
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

// Source pipelines the workflow retrieves before its stages run. These come
// from the active source API in providers/ — nothing here assumes NatGasHub.
export const SOURCE_DEFS = FEEDS.map((f) => ({
  key: f.key,
  label: f.label,
  desc: f.sourcePipeline,
}));

export const ALL_SOURCE_KEYS = SOURCE_DEFS.map((s) => s.key);
export const sourceLabel = (key) => SOURCE_DEFS.find((s) => s.key === key)?.label || key;

// Compact source names for badges/chips on workflow cards
const SOURCE_SHORT = Object.fromEntries(FEEDS.map((f) => [f.key, f.shortLabel]));
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
        // Shippers used to carry name/duns/contract/notes; they're just the
        // K-holder pair now, so older saves are folded onto the new shape.
        shippers: (w.shippers || []).map((sh) => ({
          id: sh.id,
          kHolderName: sh.kHolderName ?? sh.name ?? '',
          kHolderNumber: sh.kHolderNumber ?? sh.duns ?? '',
          action: sh.action === 'remove' ? 'remove' : 'add',
        })),
      };
    });
  } catch {
    return [];
  }
}

export function saveWorkflows(workflows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows));
}

// Per-source table names at each stage. Every provider follows the same
// naming pattern, so these are derived from the feed key; a feed whose
// pipeline stops early (IOC ends at Stage 2) contributes nothing past it.
const tablesForStage = (stage, build) =>
  Object.fromEntries(FEEDS.map((f) => [f.key, f.lastStage >= stage ? build(f.key) : []]));

// The phases Stage 3 runs through, in order. Feeds that declare `stage3Phases`
// (Firm and IT) clean their Bronze rows first — duplicates dropped, amendments
// applied, multi-part records decomposed — each phase landing one table, and
// only then standardize. Awards has no cleaning to do, so it only standardizes.
export const STAGE3_PHASES = [
  { key: 'deduplicated', label: 'Deduplication', match: (n) => n.endsWith('_deduplicated') },
  { key: 'amended', label: 'Amendments', match: (n) => n.endsWith('_amended') },
  { key: 'decomposed', label: 'Decomposition', match: (n) => n.endsWith('_decomposed') },
  { key: 'standardized', label: 'Standardization', match: (n) => n.endsWith('_standardized') },
];

// The phases before standardization — one table per source, not per grain
const STAGE3_PRE_PHASES = STAGE3_PHASES.filter((p) => p.key !== 'standardized');

/** Does this source run the pre-standardization phases in Stage 3? */
export const stage3Phased = (key) => Boolean(FEEDS.find((f) => f.key === key)?.stage3Phases);

// Stage 3: the phase tables for the sources that have them, then Locations,
// Core and Rates standardized per source
export const STAGE3_SOURCE_TABLES = tablesForStage(3, (k) => [
  ...(stage3Phased(k) ? STAGE3_PRE_PHASES.map((p) => `${k}_${p.key}`) : []),
  `${k}_locations_standardized`,
  `${k}_core_standardized`,
  `${k}_rates_standardized`,
]);

// Stage 4: rec-del paired tables per source
export const STAGE4_SOURCE_TABLES = tablesForStage(4, (k) => [
  `${k}_locations_standardized_transformed`,
]);

// Stage 5: master capacity tables per source, plus the Final tables below
export const STAGE5_SOURCE_TABLES = tablesForStage(5, (k) => [
  `${k}_core_master_capacity`,
  `${k}_locations_master_capacity`,
  `${k}_rates_master_capacity`,
]);

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

const STAGE_ICONS = { 1: '{ }', 2: '✓', 3: '≡', 4: '+', 5: 'Σ', additional: '⊞' };

// Reference tables that sit outside the numbered stages. Maintained by hand in
// Neon rather than written by a pipeline run, so every workflow shows the same
// set. Names must match the `name` fields the server exposes at /api/tables.
export const ADDITIONAL_TABLES = ['shipping', 'pipeline_attributes'];

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
  sections.push({
    key: 'additional',
    title: 'Additional Tables',
    icon: STAGE_ICONS.additional,
    tables: ADDITIONAL_TABLES,
  });
  return sections;
}
