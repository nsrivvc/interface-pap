// Reads WRITE SEMANTICS out of a pipeline run's GitHub Actions job logs.
//
// "Completed" is the least interesting thing about a run. What matters is
// which tables the run PRESERVED and which it REBUILT — because only the
// amendments ledger carries state across runs, and everything downstream of
// it is a derived view that is dropped and re-materialized every single time.
// A run that folds in zero new postings still rebuilds every downstream table
// and lands on byte-identical results; the dashboard has to be able to say so.
//
// Four write modes, straight from the pipeline's runner (src/core/runner.py):
//
//   appended   Stage 2 json_to_raw -> bronze.*. Raw archive; every load is
//              appended, duplicates included, by design. Bronze only grows.
//   preserved  *_amended only (`incremental = True`). The version-history
//              ledger. Never dropped, not even under --reload. 0 rows means
//              nothing changed and the existing Current versions are intact.
//   rebuilt    Every other Silver table. Dropped and recreated each run
//              because the stage workflows pass --reload. Same content in,
//              same content out — but the rows are physically rewritten,
//              BIGSERIAL ids restart at 1 and may land on different rows, and
//              silver_loaded_ts refreshes.
//   skipped    A non-incremental table when --reload is NOT passed. No CREATE,
//              no INSERT. A deliberate no-op.
//
// TWO SOURCES OF TRUTH, in that order:
//
//   1. `[<name>] write_mode=<mode> target=<schema>.<table>` — emitted by
//      run_one as a machine-readable restatement of the branch that decides
//      keep/drop/skip. Authoritative when present.
//   2. The runner's pre-existing prose lines, which already distinguish all
//      four cases exactly. Used when (1) is absent, so this still reads runs
//      produced by a pipeline that predates the write_mode field.
//
// Mind the dashes: the runner writes "incremental —", "skipped —" and
// "succeeded —" with an EM DASH but "reload - dropping" with a HYPHEN. The
// patterns below accept either everywhere rather than relying on that.

/** The four write modes. Also the vocabulary the client renders badges from. */
export const WRITE_MODES = ['appended', 'preserved', 'rebuilt', 'skipped'];

// Any dash the runner might use as the message separator.
const D = '[—–-]';

// GitHub prefixes every raw log line with an ISO timestamp, and Python's
// formatter adds "<ts> | <LEVEL> | <logger> | " before the message — so the
// "[name] ..." payload sits somewhere in the middle of the line, never at the
// start. Every pattern below is therefore unanchored.
const RE = {
  // [name] starting (reads: a, b)
  starting: /\[([A-Za-z0-9_.]+)\] starting \(reads: ([^)]*)\)/,
  // [name] write_mode=rebuilt target=silver.firm_core
  writeMode: new RegExp(
    `\\[([A-Za-z0-9_.]+)\\] write_mode=(${WRITE_MODES.join('|')})(?: target=(\\S+))?`
  ),
  // [name] incremental — keeping silver_staging.firm_amended and folding in new rows
  incremental: new RegExp(`\\[([A-Za-z0-9_.]+)\\] incremental ${D} keeping (\\S+) and folding`),
  // [name] reload - dropping silver.firm_core
  reload: new RegExp(`\\[([A-Za-z0-9_.]+)\\] reload ${D} dropping (\\S+)`),
  // [name] skipped — target table already exists: silver.firm_core
  skippedExists: new RegExp(
    `\\[([A-Za-z0-9_.]+)\\] skipped ${D} target table already exists: (\\S+)`
  ),
  // [name] skipped — missing sources: bronze.gtran_firm
  skippedMissing: new RegExp(`\\[([A-Za-z0-9_.]+)\\] skipped ${D} missing sources: (.+)$`),
  // [name] succeeded — 1234 rows affected in 1.20s
  succeeded: new RegExp(`\\[([A-Za-z0-9_.]+)\\] succeeded ${D} (-?\\d+) rows affected in ([\\d.]+)s`),
  // [name] FAILED after 1.20s: ValueError: boom
  failed: /\[([A-Za-z0-9_.]+)\] FAILED after ([\d.]+)s: (.+)$/,
  // SUMMARY: succeeded=7, skipped=1 | total rows affected: 4210
  summary: /SUMMARY: (.+?) \| total rows affected: (-?\d+)/,

  // The pipeline ONBOARDING GATE (core/pipeline_scope.py) emits one of these
  // per TSP it held back, alongside its prose ERROR line. A contract whose
  // (DUNS, name) is not in the pipeline_attributes register never reaches
  // staging — the rest of the load processes normally, so this is per-TSP news
  // the run card has to show rather than a run-wide failure.
  // CONTRACTS is the meaningful count; `rows` is how many copies of them sit in
  // the append-only Bronze archive, which grows every time the same file is
  // loaded again. `contracts=` is absent on runs from before that distinction
  // existed, so the row count stands in.
  //   pipeline_rejected duns=964493527 name=Stallion … contracts=1 rows=2 feed=firm
  pipelineRejected:
    /pipeline_rejected duns=(\S*) name=(.*?)(?: contracts=(\d+))? rows=(\d+) feed=(\S*)/,

  // Stage 2 is a standalone loader (json_to_raw.py), not a registered
  // transformation — it never goes through run_one, so it has no "[name]"
  // lines at all. It print()s these two instead:
  //   firm_2026-01-01.json -> FIRM -> bronze.gtran_firm
  //   Done. records=120 written=120 invalid=0
  bronzeTarget: /^(\S+\.json) -> (\S+) -> (\S+\.\S+)$/,
  bronzeDone: /^Done\. records=(\d+) written=(\d+) invalid=(\d+)$/,
};

// GitHub stamps every raw log line with its own ISO timestamp before the
// process's own output. The stage-2 patterns above are anchored (their lines
// are bare print()s with no "[name]" to key on), so the stamp has to come off
// first or they never match.
const GH_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s/;

/**
 * Which pipeline step a transformation name belongs to.
 *
 * Order matters: `_master_capacity` must be tested before the bare
 * core/locations/rates decomposition names, or silver_firm_core_master_capacity
 * would be misread as a Stage 3 decomposition table.
 */
export function stepOf(name) {
  const n = String(name).toLowerCase();
  if (n.includes('json_to_raw') || n.startsWith('bronze_')) return 'bronze';
  if (n.endsWith('_master_capacity')) return n.includes('final') ? 'final' : 'master';
  if (n.endsWith('_rec_del_pair')) return 'pairing';
  if (n.endsWith('_dedup') || n.endsWith('_deduplicated')) return 'dedup';
  if (n.endsWith('_amended')) return 'amendments';
  if (/_(core|locations|rates)$/.test(n)) return 'decomposition';
  return 'other';
}

/**
 * Write mode inferred from a transformation's NAME alone — the last resort,
 * used when a run's log carries neither a write_mode line nor a
 * keeping/dropping/skipped line for it (e.g. the run created the table for the
 * first time, so there was nothing to keep or drop).
 *
 * `*_amended` is the only incremental target in the pipeline, which is what
 * makes this safe: everything else is dropped and rebuilt under --reload.
 */
function modeFromName(name) {
  const step = stepOf(name);
  if (step === 'bronze') return 'appended';
  if (step === 'amendments') return 'preserved';
  return 'rebuilt';
}

const blank = (name) => ({
  name,
  step: stepOf(name),
  status: 'running', // until a succeeded/failed/skipped line lands
  writeMode: '',
  writeModeSource: '', // 'explicit' | 'inferred' | 'name'
  target: '',
  rows: null,
  durationS: null,
  error: '',
});

/**
 * Parse one job's raw log text into per-transformation write semantics.
 *
 * Returns { transformations, summary }. A transformation that has a `starting`
 * line but no terminal line is still `running` — that is what makes the
 * dashboard able to show write modes live, mid-run, rather than only at the
 * end: the write_mode / keeping / dropping line is emitted BEFORE the
 * transformation does its work.
 */
export function parseRunnerLog(text) {
  const found = new Map(); // name -> record, insertion-ordered = execution order
  const rejected = new Map(); // "duns|name" -> { duns, name, rows, feed }
  let summary = null;
  let pendingBronze = null; // the "-> bronze.x" line waiting for its "Done." line

  const at = (name) => {
    if (!found.has(name)) found.set(name, blank(name));
    return found.get(name);
  };
  // Only ever upgrade the mode: explicit beats inferred beats name-guess.
  const setMode = (rec, mode, source, target) => {
    const rank = { name: 1, inferred: 2, explicit: 3 };
    if ((rank[source] || 0) >= (rank[rec.writeModeSource] || 0)) {
      rec.writeMode = mode;
      rec.writeModeSource = source;
    }
    if (target && !rec.target) rec.target = target;
  };

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(GH_STAMP, '').trim();
    if (!line) continue;
    let m;

    // --- Stage 2's standalone loader ---------------------------------------
    if ((m = RE.bronzeTarget.exec(line))) {
      pendingBronze = { file: m[1], feed: m[2], target: m[3] };
      continue;
    }
    if ((m = RE.bronzeDone.exec(line))) {
      // Name the record after the target table so several files loaded in one
      // job aggregate onto the one Bronze table they all land in.
      const target = pendingBronze?.target || 'bronze';
      const name = `json_to_raw:${target}`;
      const rec = at(name);
      rec.step = 'bronze';
      rec.status = 'succeeded';
      rec.target = target;
      rec.rows = (rec.rows || 0) + Number(m[2]); // written
      rec.invalid = (rec.invalid || 0) + Number(m[3]);
      setMode(rec, 'appended', 'inferred', target);
      pendingBronze = null;
      continue;
    }

    // --- run_one's per-transformation lines ---------------------------------
    if ((m = RE.writeMode.exec(line))) {
      const rec = at(m[1]);
      setMode(rec, m[2], 'explicit', m[3]);
      continue;
    }
    if ((m = RE.starting.exec(line))) {
      const rec = at(m[1]);
      rec.reads = m[2];
      continue;
    }
    if ((m = RE.incremental.exec(line))) {
      setMode(at(m[1]), 'preserved', 'inferred', m[2]);
      continue;
    }
    if ((m = RE.reload.exec(line))) {
      setMode(at(m[1]), 'rebuilt', 'inferred', m[2]);
      continue;
    }
    if ((m = RE.skippedExists.exec(line))) {
      const rec = at(m[1]);
      rec.status = 'skipped';
      rec.rows = 0;
      rec.error = `target table already exists: ${m[2]}`;
      setMode(rec, 'skipped', 'inferred', m[2]);
      continue;
    }
    if ((m = RE.skippedMissing.exec(line))) {
      const rec = at(m[1]);
      rec.status = 'skipped';
      rec.rows = 0;
      rec.error = `missing sources: ${m[2].trim()}`;
      setMode(rec, 'skipped', 'inferred');
      continue;
    }
    if ((m = RE.succeeded.exec(line))) {
      const rec = at(m[1]);
      rec.status = 'succeeded';
      rec.rows = Number(m[2]);
      rec.durationS = Number(m[3]);
      continue;
    }
    if ((m = RE.failed.exec(line))) {
      const rec = at(m[1]);
      rec.status = 'failed';
      rec.durationS = Number(m[2]);
      rec.error = m[3].trim();
      continue;
    }
    if ((m = RE.pipelineRejected.exec(line))) {
      const rows = Number(m[4]);
      const rec = {
        duns: m[1],
        name: m[2].trim(),
        contracts: m[3] === undefined ? rows : Number(m[3]),
        rows,
        feed: m[5],
      };
      rejected.set(`${rec.duns}|${rec.name}`, rec); // same TSP logged once per job
      continue;
    }
    if ((m = RE.summary.exec(line))) {
      const counts = {};
      for (const part of m[1].split(',')) {
        const [k, v] = part.trim().split('=');
        if (k) counts[k] = Number(v);
      }
      summary = { counts, totalRows: Number(m[2]) };
    }
  }

  // Anything still without a mode gets the name-based guess, so every record
  // the UI shows carries one of the four badges rather than a blank.
  for (const rec of found.values()) {
    if (!rec.writeMode) setMode(rec, modeFromName(rec.name), 'name');
  }
  return { transformations: [...found.values()], summary, rejected: [...rejected.values()] };
}

// The steps the dashboard shows, in pipeline order. `stage` ties each one back
// to the stage pill it sits under.
export const STEP_ORDER = [
  { key: 'bronze', stage: 2 },
  { key: 'dedup', stage: 3 },
  { key: 'amendments', stage: 3 },
  { key: 'decomposition', stage: 3 },
  { key: 'pairing', stage: 4 },
  { key: 'master', stage: 5 },
  { key: 'final', stage: 5 },
  { key: 'other', stage: 5 },
];

/**
 * One record per transformation NAME across every job of a dispatch.
 *
 * The same transformation legitimately shows up in several jobs — the three
 * cross-feed FINAL tables run at the end of whichever feed chains ran, and a
 * re-run job replays its whole log. Summing those would report rows the run
 * never wrote, so keep exactly one record per name: the furthest along, and on
 * a tie the last seen (a re-run supersedes the attempt before it).
 */
function dedupeByName(records) {
  const rank = { running: 0, skipped: 1, failed: 2, succeeded: 3 };
  const best = new Map();
  for (const rec of records) {
    const prev = best.get(rec.name);
    if (!prev || (rank[rec.status] ?? 0) >= (rank[prev.status] ?? 0)) best.set(rec.name, rec);
  }
  return [...best.values()];
}

/** Roll a step's transformations up into one status for its row. */
function rollupStatus(records) {
  if (records.some((r) => r.status === 'failed')) return 'failed';
  if (records.some((r) => r.status === 'running')) return 'running';
  if (records.every((r) => r.status === 'skipped')) return 'skipped';
  return 'succeeded';
}

/**
 * Roll a step's transformations up into ONE write mode.
 *
 * Skipped entries are set aside first: a step where one table was skipped and
 * three were rebuilt is a REBUILT step, not an ambiguous one. Only when every
 * entry was skipped does the step read as SKIPPED.
 */
function rollupMode(records) {
  const live = records.filter((r) => r.writeMode && r.writeMode !== 'skipped');
  if (!live.length) return records.length ? 'skipped' : '';
  for (const mode of ['preserved', 'appended', 'rebuilt']) {
    if (live.some((r) => r.writeMode === mode)) return mode;
  }
  return live[0].writeMode;
}

/**
 * Aggregate every parsed transformation across every job of a dispatch into
 * the per-step rows the dashboard renders, plus the run-level numbers it needs
 * to say whether the run actually changed anything.
 */
export function summarizeWrites(transformations, rejections = []) {
  const all = dedupeByName(transformations.filter(Boolean));
  // One entry per TSP across every job — the same rejection is logged by each
  // feed's dedup, so key it rather than counting it twice.
  const rejected = [
    ...new Map(rejections.filter(Boolean).map((r) => [`${r.duns}|${r.name}`, r])).values(),
  ];
  const steps = [];
  for (const { key, stage } of STEP_ORDER) {
    const records = all.filter((r) => r.step === key);
    if (!records.length) continue;
    // rows is null while a transformation is still running — don't count it
    // as a zero, or a mid-run step would claim it wrote nothing.
    const counted = records.filter((r) => typeof r.rows === 'number');
    steps.push({
      key,
      stage,
      mode: rollupMode(records),
      status: rollupStatus(records),
      rows: counted.length ? counted.reduce((s, r) => s + Math.max(0, r.rows), 0) : null,
      tables: records.map((r) => r.target).filter(Boolean),
      skipped: records.filter((r) => r.status === 'skipped').length,
      count: records.length,
      // True only if every mode came from a write_mode= line or a
      // keeping/dropping line, i.e. nothing here is a name-based guess.
      certain: records.every((r) => r.writeModeSource && r.writeModeSource !== 'name'),
      errors: records.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.error}`),
    });
  }

  const step = (k) => steps.find((s) => s.key === k) || null;
  const amendments = step('amendments');

  // DO NOT add row counts across steps. Dedup rows are contracts, decomposition
  // rows are core/locations/rates fragments, master-capacity rows are something
  // else again — summing them produces a number with no grain and no meaning.
  // What the run IS measured against is the raw rows that entered Bronze: every
  // downstream table is derived from those, so that is the one honest reference
  // point. Breadth of the rebuild is a COUNT OF TABLES, not a count of rows.
  const rebuiltTables = all.filter((r) => r.writeMode === 'rebuilt').length;

  return {
    steps,
    // null (not 0) when the amendments step has not reported yet, so the UI can
    // tell "nothing new" apart from "don't know yet".
    amendedRows: amendments && typeof amendments.rows === 'number' ? amendments.rows : null,
    amendmentsRan: Boolean(amendments),
    // Rows that entered the raw archive on this run — what everything
    // downstream is derived from, and what the run should be described against.
    rawRows: step('bronze')?.rows ?? null,
    rebuiltTables,
    bronzeRows: step('bronze')?.rows ?? null,
    dedupRows: step('dedup')?.rows ?? null,
    anyRebuilt: steps.some((s) => s.mode === 'rebuilt'),
    // Contracts held back by the pipeline onboarding gate, if any.
    rejected,
    rejectedContracts: rejected.reduce((sum, r) => sum + (r.contracts || 0), 0),
    rejectedRows: rejected.reduce((sum, r) => sum + (r.rows || 0), 0),
    transformations: all,
  };
}
