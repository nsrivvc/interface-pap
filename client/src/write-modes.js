// How a run's WRITE SEMANTICS are worded and coloured on a workflow card.
//
// "Last run completed" is the least useful thing a run can tell you. Run the
// same workflow twice and you get "completed" both times, with no way to see
// that the second run folded in nothing new. What actually differs between
// runs is which tables were preserved and which were rewritten:
//
//   ONLY THE AMENDMENTS LEDGER CARRIES STATE ACROSS RUNS.
//   Everything downstream of it is a derived view, recomputed and
//   re-materialized on every single run.
//
// So a run that processes zero new postings still rebuilds every downstream
// table — and lands on identical results. That is the distinction these
// strings exist to make legible.
//
// The parsing that produces this data lives in server/src/runlog.js; the modes
// themselves come from the pipeline's runner (src/core/runner.py::run_one).

/**
 * The four write modes.
 *
 * `tone` drives the badge colour, and the important call is that REBUILT is
 * NOT an error colour — a rebuild is the normal, designed behaviour of every
 * Silver table. It reads as "replaced" (amber), while PRESERVED reads as
 * "safe, untouched" (green) and SKIPPED as an inert no-op (grey). Red stays
 * reserved for jobs that actually failed.
 */
export const WRITE_MODE_INFO = {
  appended: {
    label: 'APPENDED',
    tone: 'appended',
    title: 'Rows added to the raw archive. Nothing is removed — Bronze grows on every run.',
  },
  preserved: {
    label: 'PRESERVED',
    tone: 'preserved',
    title:
      'Kept as-is. This table is version history: it is never dropped, not even ' +
      'on a reload. New rows are folded in; existing versions stay intact.',
  },
  rebuilt: {
    label: 'REBUILT',
    tone: 'rebuilt',
    title:
      'Dropped and recreated from source this run. Same content in, same content ' +
      'out — but the rows are physically rewritten, the ids restart at 1, and ' +
      'silver_loaded_ts refreshes. This is normal, not an error.',
  },
  skipped: {
    label: 'SKIPPED',
    tone: 'skipped',
    title: 'No CREATE, no INSERT — a deliberate no-op. The table was left exactly as it was.',
  },
};

/** The steps a run reports on, in pipeline order. Keys match runlog.js's stepOf(). */
export const WRITE_STEPS = {
  bronze: { label: 'Stage 2 · Load to Bronze' },
  dedup: { label: 'Stage 3 p1 · Deduplication' },
  amendments: { label: 'Stage 3 p2 · Amendments' },
  decomposition: { label: 'Stage 3 p3 · Decomposition' },
  pairing: { label: 'Stage 4 · Receipt/delivery pairing' },
  master: { label: 'Stage 5 · Master capacity' },
  final: { label: 'Stage 5 · Final' },
  other: { label: 'Other transformations' },
};

const n = (v) => (typeof v === 'number' ? v.toLocaleString() : null);
const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many}`;

/**
 * One line of plain English saying what this step's write mode MEANS for its
 * table — not what the stage is called, which the label already says.
 *
 * Every branch degrades gracefully: a step still running has no row count yet,
 * and the dedup line can only quote the raw total if Stage 2 reported one, so
 * neither is allowed to render "undefined rows".
 */
export function writeStepCopy(step, run) {
  const { key, mode, rows, status, skipped, count } = step;

  if (mode === 'skipped') {
    return count > 1
      ? `Skipped — all ${count} tables already existed, so nothing was written`
      : 'Skipped — the table already existed, so nothing was written';
  }
  if (status === 'failed') return 'Failed — see the run log on GitHub';

  const pending = typeof rows !== 'number';

  switch (key) {
    case 'bronze':
      return 'Appending to the raw archive — every load is kept, duplicates included';

    case 'dedup': {
      if (pending) return 'Rebuilt — collapsing raw rows to unique contracts';
      const raw = run?.bronzeRows;
      return typeof raw === 'number'
        ? `Rebuilt — collapsed ${n(raw)} raw rows to ${n(rows)} unique contracts`
        : `Rebuilt — collapsed to ${plural(rows, 'unique contract', 'unique contracts')}`;
    }

    case 'amendments': {
      if (pending) return 'Preserved — version history kept; folding in new postings';
      return rows === 0
        ? 'Preserved — version history kept; no new postings, existing versions untouched'
        : `Preserved — version history kept; ${plural(rows, 'new posting', 'new postings')} folded in`;
    }

    case 'decomposition':
      return 'Rebuilt from the current contract versions';

    case 'pairing':
      return pending ? 'Rebuilt' : `Rebuilt — ${plural(rows, 'pair', 'pairs')} rewritten`;

    case 'master':
    case 'final':
      return pending
        ? 'Rebuilt — rows rewritten; row ids reassigned'
        : `Rebuilt — ${plural(rows, 'row', 'rows')} rewritten; row ids reassigned`;

    default:
      if (mode === 'preserved') return 'Preserved — kept across runs, new rows folded in';
      if (mode === 'appended') return 'Appended — rows added, nothing removed';
      return pending ? 'Rebuilt' : `Rebuilt — ${plural(rows, 'row', 'rows')} rewritten`;
  }
  // `skipped` is folded into the mode check above; a step with SOME skipped
  // entries still reports its real mode, with the count noted separately.
}

/** "2 of 5 tables skipped" — shown beside a step that was only partly written. */
export function partialSkipNote(step) {
  if (!step.skipped || step.mode === 'skipped') return null;
  return `${step.skipped} of ${step.count} skipped`;
}

/**
 * The run-level verdict: did this run actually change anything?
 *
 * The amendments ledger is the only table that carries state between runs, so
 * its row count is the whole answer. Zero means nothing new arrived — and the
 * point worth making is that every downstream table was still rebuilt anyway,
 * to exactly the same rows.
 *
 * Returns null while the answer isn't known yet (the amendments step hasn't
 * reported), so the UI can stay quiet rather than guess.
 */
export function runWriteVerdict(writes) {
  if (!writes || !writes.amendmentsRan) return null;
  const { amendedRows, rebuiltTables, rawRows } = writes;
  if (typeof amendedRows !== 'number') return null;

  // The scale of a rebuild is how many TABLES were re-materialized, measured
  // against the raw rows they all derive from. Row counts are not comparable
  // across steps — see summarizeWrites — so they are never added up here.
  const scale = rebuiltTables
    ? `${plural(rebuiltTables, 'table', 'tables')} rebuilt` +
      (typeof rawRows === 'number' ? ` from the same ${plural(rawRows, 'raw row', 'raw rows')}` : '')
    : '';

  if (amendedRows === 0) {
    // Two different no-ops, and they must not be worded the same. Normally the
    // stage workflows pass --reload, so everything downstream is still torn
    // down and rebuilt from identical input. Without --reload nothing
    // downstream is touched at all — claiming a rebuild there would be a lie.
    let detail = 'No new postings were found, so the contract version history is unchanged.';
    if (!writes.anyRebuilt) {
      detail += ' Nothing downstream was rewritten either — those tables already existed.';
    } else if (scale) {
      detail += ` Everything downstream was still re-materialized: ${scale}, landing on identical results.`;
    } else {
      detail += ' Everything downstream was still re-materialized, landing on identical results.';
    }
    return { kind: 'noop', headline: 'Nothing new to process.', detail };
  }
  return {
    kind: 'changed',
    headline: `${plural(amendedRows, 'new posting', 'new postings')} applied.`,
    // The count of superseded versions is not something the run reports — the
    // amendments transformation returns rows inserted, not rows it flipped out
    // of Current. Better to say nothing than to invent a number.
    detail:
      'Contract version history was extended; superseded versions were retained, not deleted.' +
      (scale ? ` ${scale[0].toUpperCase()}${scale.slice(1)}.` : ''),
  };
}

/**
 * The standing caveat about REBUILT tables. Informational, not an error: ids
 * on a rebuilt table are handed out fresh by BIGSERIAL each run and may land
 * on different rows, so nothing downstream can treat one as a stable key.
 */
export const REBUILD_ID_WARNING =
  'Row ids on rebuilt tables are not stable across runs — BIGSERIAL restarts at 1 ' +
  'and may attach to different rows. Do not treat final_locations_id (or any ' +
  'rebuilt table id) as a persistent key.';
