// The whole Contract Workflow Dashboard UI, in three parts:
//   1. Scenarios panel — create/delete scenarios; each pins choices from the
//      reference data (stored in Neon via /api/scenarios).
//   2. Workflow setup/edit forms — name, ONE attached scenario (dropdown),
//      sources to pull, optional daily trigger time (saved in localStorage).
//   3. Run tracking — dispatches the real GitHub Actions pipelines and polls
//      their run/job status into the stage pills until every feed finishes.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  STAGE_DEFS,
  SOURCE_DEFS,
  ALL_SOURCE_KEYS,
  sourceLabel,
  shortSourceLabel,
  loadWorkflows,
  saveWorkflows,
} from '../workflow-defs';
import { FEED_WORKFLOW_FILES } from '../providers/index.js';
import {
  WRITE_MODE_INFO,
  WRITE_STEPS,
  writeStepCopy,
  partialSkipNote,
  runWriteVerdict,
  REBUILD_ID_WARNING,
} from '../write-modes.js';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Workflow file per source, from the active source API in providers/ (mirrors
// the server's mapping). A feed that runs stages 1-5 dispatches its end-to-end
// orchestrator — every stage runs as a job of that ONE run; a feed that stops
// after stage 2 points at its ingest-only workflow.
const SOURCE_FILES = FEED_WORKFLOW_FILES;
// Match the runs' job names onto the UI's pills. Jobs arrive like
// "stage 1-2 - ingest to bronze / ingest", "stage 3 - bronze to silver / run",
// "stage 5 - firm core / run", "final - rates / run".
const INGEST_JOB_RE = /stage.?_?1|ingest/i;
const STAGE_JOB_RE = {
  3: /stage.?_?3|bronze.?to.?silver/i,
  4: /stage.?_?4|rec.?del/i,
  5: /stage.?_?5|master.?capacity|final/i,
};
const ghState = (status, conclusion) =>
  status !== 'completed' ? 'running' : conclusion === 'success' ? 'done' : 'failed';

// Per-job pill state: a queued job hasn't started yet, so its pill stays dim
// ('pending') until GitHub actually starts executing it. Skipped jobs also
// read as pending rather than failed.
const jobState = (status, conclusion) =>
  status === 'completed'
    ? conclusion === 'success'
      ? 'done'
      : conclusion === 'skipped'
        ? 'pending'
        : 'failed'
    : status === 'in_progress'
      ? 'running'
      : 'pending';

// An in-flight dispatch survives page navigation/refresh via localStorage, so
// the card keeps updating (and records the outcome) after coming back.
const ACTIVE_RUN_KEY = 'pap_active_run_v1';

// The reference data points a scenario pins — one dropdown each, fed by
// /api/scenario-options from the live reference tables.
const SCENARIO_FIELDS = [
  { key: 'source', label: 'Source', single: true }, // one source API per scenario — no ＋
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'shipper', label: 'Shipper' },
  { key: 'location', label: 'Location' },
  { key: 'pairing', label: 'Rec-Del Pairing' },
];

const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'UTC', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Singapore',
      'Asia/Tokyo', 'Australia/Sydney',
    ];
  }
})();

/** "HH:MM" right now in the given IANA timezone. */
function currentTimeIn(tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
}

/** Date key ("YYYY-MM-DD") for today in the given timezone, to fire once per day. */
function dateKeyIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(new Date());
}

/** Human countdown until the next daily occurrence of "HH:MM" in the given timezone. */
function nextRunIn(time, tz) {
  const [th, tm] = time.split(':').map(Number);
  const [nh, nm] = currentTimeIn(tz).split(':').map(Number);
  const diff = (th * 60 + tm - (nh * 60 + nm) + 1440) % 1440;
  if (diff === 0) return 'now';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

// The reference points a scenario pins, shown under the scenario dropdowns
function ScenarioSummary({ scenario }) {
  if (!scenario?.config) return null;
  const parts = SCENARIO_FIELDS.filter(
    (f) => scenario.config[f.key] && scenario.config[f.key].length
  );
  if (!parts.length) return null;
  return (
    <div className="scenario-config-summary" style={{ marginTop: 8 }}>
      {parts.map((f) => (
        <span key={f.key}>
          <em>{f.label}:</em>{' '}
          {Array.isArray(scenario.config[f.key])
            ? scenario.config[f.key].join(', ')
            : scenario.config[f.key]}
        </span>
      ))}
    </div>
  );
}

/**
 * WRITE SEMANTICS for a run — the part "completed" hides.
 *
 * One row per pipeline step, live as it executes: a badge for how the step
 * touched its table, the rows it moved, and one line of plain English saying
 * what that mode means for that table. The distinction being drawn is that
 * only the amendments ledger (PRESERVED) carries state across runs; every
 * other Silver table is REBUILT from scratch every single run, whether or not
 * anything new arrived.
 */
function WriteSemantics({ writes }) {
  const steps = writes?.steps || [];
  const rejected = writes?.rejected || [];
  if (!steps.length && !rejected.length) return null;

  return (
    <div className="run-detail-sec">
      {/* Contracts the onboarding gate turned away. Shown ABOVE the write rows
          because it explains a short load: those rows never reached staging,
          so every count below is missing them on purpose. */}
      {rejected.length > 0 && (
        <div className="gate-reject">
          <div className="gate-reject-head">
            ⚠ {writes.rejectedRows} contract row
            {writes.rejectedRows === 1 ? '' : 's'} rejected — pipeline not registered
          </div>
          {rejected.map((r) => (
            <div key={`${r.duns}|${r.name}`} className="gate-reject-row">
              <span className="gate-reject-name">{r.name || '(no name)'}</span>
              <span className="gate-reject-duns">{r.duns || '(no duns)'}</span>
              <span className="gate-reject-rows">
                {r.rows} row{r.rows === 1 ? '' : 's'} held back
              </span>
            </div>
          ))}
          <div className="gate-reject-fix">
            Their TSP name and DUNS have no matching row in the pipeline attributes
            register, so their contracts were not loaded. Add the pipeline to the
            reference table (and to the scenario, if it pins specific pipelines) —
            everything else in this load processed normally.
          </div>
        </div>
      )}
      {steps.length > 0 && (
      <div className="run-detail-head">✎ Write semantics — what this run did to each table</div>
      )}
      {steps.map((step) => {
        const info = WRITE_MODE_INFO[step.mode] || WRITE_MODE_INFO.skipped;
        const note = partialSkipNote(step);
        const tables = step.tables.join(', ');
        return (
          <div key={step.key} className={`write-row ${step.status}`}>
            <div className="write-row-top">
              <span
                className={`write-badge ${info.tone}`}
                title={
                  info.title +
                  (step.certain
                    ? ''
                    : '\n\n(Inferred from the transformation name — this run\'s log ' +
                      'did not state the write mode outright.)')
                }
              >
                {info.label}
              </span>
              <span className="write-step-label" title={tables || undefined}>
                {WRITE_STEPS[step.key]?.label || step.key}
              </span>
              {step.status === 'running' && <span className="spin">⟳</span>}
              {note && <span className="write-note">{note}</span>}
              <span className="write-rows">
                {typeof step.rows === 'number'
                  ? `${step.rows.toLocaleString()} row${step.rows === 1 ? '' : 's'}`
                  : '…'}
                {/* A step spanning several tables (stage 5 core/locations/rates)
                    sums rows of the SAME grain, but say how many tables that is
                    so the number is never mistaken for one table's size. */}
                {step.count > 1 && (
                  <span className="write-rows-sub"> · {step.count} tables</span>
                )}
              </span>
            </div>
            <div className="write-copy">{writeStepCopy(step, writes)}</div>
            {step.errors.length > 0 && (
              <div className="write-copy write-error">{step.errors.join(' · ')}</div>
            )}
          </div>
        );
      })}
      {writes.anyRebuilt && (
        <div className="write-caveat">
          <span className="write-caveat-icon">ⓘ</span>
          {REBUILD_ID_WARNING}
        </div>
      )}
    </div>
  );
}

/**
 * How the run ended, as ONE statement: that every stage finished, and whether
 * anything actually changed. These were two stacked banners before, which read
 * as two unrelated verdicts — "complete" is only the first half of the answer,
 * so the outcome and the verdict belong in the same block.
 */
function RunOutcome({ verdict }) {
  return (
    <div className={`wf-outcome ${verdict?.kind || 'plain'}`}>
      <span className="wf-outcome-icon">✓</span>
      <div className="wf-outcome-body">
        <div className="wf-outcome-head">
          Workflow complete — every pipeline stage finished successfully.
        </div>
        {verdict && (
          <div className="wf-outcome-verdict">
            <strong>{verdict.headline}</strong> {verdict.detail}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowPanel({ onPipelineRan }) {
  const [workflows, setWorkflows] = useState(loadWorkflows);

  // Scenarios — created here on the dashboard (stored in Neon), then attached
  // to workflows. Their contents are defined later; today they're named
  // configurations a workflow can reference.
  const [scenarios, setScenarios] = useState([]);
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioDesc, setScenarioDesc] = useState('');
  // One stacked group per reference point, each holding one or more value
  // dropdowns — ＋ beside the last dropdown adds another slot for that point
  const emptyPicks = () => Object.fromEntries(SCENARIO_FIELDS.map((f) => [f.key, ['']]));
  const [scenarioPicks, setScenarioPicks] = useState(emptyPicks);
  const [scenarioOptions, setScenarioOptions] = useState(null); // dropdown choices
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [scenarioError, setScenarioError] = useState('');
  // The whole panel tucks away behind its header; the choice sticks per browser
  const [scenariosOpen, setScenariosOpen] = useState(() => {
    try {
      return localStorage.getItem('scenarios-open') !== '0';
    } catch {
      return true;
    }
  });
  const toggleScenarios = () =>
    setScenariosOpen((o) => {
      try {
        localStorage.setItem('scenarios-open', o ? '0' : '1');
      } catch {
        // storage unavailable — the panel still toggles, just isn't remembered
      }
      return !o;
    });

  const setPick = (key, i, value) =>
    setScenarioPicks((p) => ({
      ...p,
      [key]: p[key].map((v, idx) => (idx === i ? value : v)),
    }));
  const addPick = (key) => setScenarioPicks((p) => ({ ...p, [key]: [...p[key], ''] }));
  const removePick = (key, i) =>
    setScenarioPicks((p) => ({ ...p, [key]: p[key].filter((_, idx) => idx !== i) }));

  // Pipeline DUNS -> the shippers that trade on it, from /api/scenario-options.
  // Not reference data anyone maintains: it is read off the loaded contracts.
  const [pipelineShippers, setPipelineShippers] = useState({});
  // Which shipper picks this mapping put there, so changing a pipeline can
  // retract ITS shippers without disturbing any the user added by hand.
  const autoShippersRef = useRef([]);
  const pipelineKey = (scenarioPicks.pipeline || []).join('|');

  useEffect(() => {
    // A pipeline is picked as "Name (DUNS)" — the DUNS is what maps.
    const derived = [];
    for (const label of scenarioPicks.pipeline || []) {
      const duns = /\(([^()]+)\)\s*$/.exec(label || '')?.[1]?.trim();
      for (const sh of (duns && pipelineShippers[duns]) || []) {
        if (!derived.includes(sh)) derived.push(sh);
      }
    }
    const previous = autoShippersRef.current;
    const unchanged =
      derived.length === previous.length && derived.every((d, i) => d === previous[i]);
    if (unchanged) return;

    setScenarioPicks((p) => {
      // Anything not placed by the last auto-fill is the user's own pick.
      const manual = (p.shipper || []).filter((v) => v && !previous.includes(v));
      const next = [...new Set([...derived, ...manual])];
      return { ...p, shipper: next.length ? next : [''] };
    });
    autoShippersRef.current = derived;
    // pipelineKey (not the array) so this settles instead of re-firing on every
    // scenarioPicks change, including the one this effect itself makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineKey, pipelineShippers]);

  useEffect(() => {
    api('/api/scenarios')
      .then((d) => setScenarios(d.scenarios))
      .catch((err) => setScenarioError(err.message));
    api('/api/scenario-options')
      .then((d) => {
        setScenarioOptions(d.options);
        setPipelineShippers(d.pipelineShippers || {});
      })
      .catch(() => {
        // dropdowns just render empty — the create form still works
      });
  }, []);

  const createScenario = async () => {
    if (!scenarioName.trim() || scenarioBusy) return;
    setScenarioBusy(true);
    setScenarioError('');
    try {
      const { scenario } = await api('/api/scenarios', {
        method: 'POST',
        body: {
          name: scenarioName.trim(),
          description: scenarioDesc.trim(),
          config: Object.fromEntries(
            SCENARIO_FIELDS.map((f) => [f.key, scenarioPicks[f.key].filter(Boolean)]).filter(
              ([, vals]) => vals.length
            )
          ),
        },
      });
      setScenarios((s) => [...s, scenario]);
      setScenarioName('');
      setScenarioDesc('');
      setScenarioPicks(emptyPicks());
    } catch (err) {
      setScenarioError(err.message);
    } finally {
      setScenarioBusy(false);
    }
  };

  const deleteScenario = async (id) => {
    setScenarioError('');
    try {
      await api(`/api/scenarios/${id}`, { method: 'DELETE' });
      setScenarios((s) => s.filter((x) => x.id !== id));
      // Detach the deleted scenario from any workflow still referencing it
      setWorkflows((ws) => {
        const next = ws.map((w) =>
          w.scenarios?.includes(id)
            ? { ...w, scenarios: w.scenarios.filter((x) => x !== id) }
            : w
        );
        saveWorkflows(next);
        return next;
      });
    } catch (err) {
      setScenarioError(err.message);
    }
  };

  // Setup form
  const [configuring, setConfiguring] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftSources, setDraftSources] = useState(ALL_SOURCE_KEYS);
  const [draftScenario, setDraftScenario] = useState(''); // one scenario id (as string)
  const [draftTime, setDraftTime] = useState(''); // "HH:MM", empty = no schedule
  const [draftTz, setDraftTz] = useState(LOCAL_TZ);
  // Run state:
  // { id, trigger, batchId, sourceStates, stageStates, github, githubRuns,
  //   githubDone, error, finished }
  // A run isn't over when the local stages finish — the dispatched GitHub
  // Actions workflows must complete too (githubDone).
  const [run, setRun] = useState(null);
  const isRunning =
    run !== null && !run.error && (!run.finished || (run.github && !run.githubDone));

  // Manual workflow triggers
  const [triggering, setTriggering] = useState(null); // source key while a trigger runs
  const [triggerStatus, setTriggerStatus] = useState(null); // { ok, text }

  const manualTrigger = async (src) => {
    setTriggering(src.key);
    setTriggerStatus(null);
    try {
      const result = await api('/api/pipeline/trigger-ingest', {
        method: 'POST',
        body: { source: src.key },
      });
      setTriggerStatus({
        ok: true,
        text: `Manual trigger — dispatched ${result.dispatched[0]} (stage 1-2 ingest) on GitHub. Bronze rows land when the run finishes.`,
      });
    } catch (err) {
      setTriggerStatus({ ok: false, text: `Manual trigger — ${src.label} failed: ${err.message}` });
    } finally {
      setTriggering(null);
    }
  };

  const toggleSource = (key) => {
    setDraftSources((sources) =>
      sources.includes(key) ? sources.filter((s) => s !== key) : [...sources, key]
    );
  };

  const resetForm = () => {
    setConfiguring(false);
    setDraftName('');
    setDraftSources(ALL_SOURCE_KEYS);
    setDraftScenario('');
    setDraftTime('');
    setDraftTz(LOCAL_TZ);
  };

  const saveWorkflow = () => {
    if (draftSources.length === 0) return;
    const name = draftName.trim() || `Workflow ${workflows.length + 1}`;
    // Keep sources in pipeline order regardless of click order
    const sources = ALL_SOURCE_KEYS.filter((k) => draftSources.includes(k));
    const schedule = draftTime ? { time: draftTime, tz: draftTz } : null;
    // Every workflow runs the full pipeline: Stage 1 plus all of Stages 2-5.
    // Components (pipelines, shippers, rec-del pairings) live in their own
    // warehouse tables now, not on the workflow itself.
    const next = [
      ...workflows,
      {
        id: Date.now(),
        name,
        stageCount: STAGE_DEFS.length,
        sources,
        // Storage keeps the array shape; a workflow carries at most one scenario
        scenarios: draftScenario ? [Number(draftScenario)] : [],
        schedule,
      },
    ];
    setWorkflows(next);
    saveWorkflows(next);
    resetForm();
  };

  const clearSchedule = (id) => {
    const next = workflows.map((w) => (w.id === id ? { ...w, schedule: null } : w));
    setWorkflows(next);
    saveWorkflows(next);
  };

  // Full inline editor on an existing workflow card: name, sources, trigger time
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null); // { name, sources, time, tz }

  const startEdit = (wf) => {
    setEditingId(wf.id);
    setEditDraft({
      name: wf.name,
      sources: wf.sources,
      scenario: String((wf.scenarios || [])[0] ?? ''),
      time: wf.schedule?.time || '',
      tz: wf.schedule?.tz || LOCAL_TZ,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const toggleEditSource = (key) =>
    setEditDraft((d) => ({
      ...d,
      sources: d.sources.includes(key)
        ? d.sources.filter((s) => s !== key)
        : [...d.sources, key],
    }));

  const saveEdit = () => {
    if (!editDraft.sources.length) return;
    const next = workflows.map((w) =>
      w.id === editingId
        ? {
            ...w,
            name: editDraft.name.trim() || w.name,
            sources: ALL_SOURCE_KEYS.filter((k) => editDraft.sources.includes(k)),
            scenarios: editDraft.scenario ? [Number(editDraft.scenario)] : [],
            schedule: editDraft.time ? { time: editDraft.time, tz: editDraft.tz } : null,
          }
        : w
    );
    setWorkflows(next);
    saveWorkflows(next);
    cancelEdit();
  };

  // Stop tracking the active run and ask the server to cancel the in-flight
  // GitHub Actions runs it dispatched (best effort — the card clears either way).
  const cancelRun = (recordOnId = null) => {
    const cur = run;
    localStorage.removeItem(ACTIVE_RUN_KEY);
    setRun(null);
    if (recordOnId != null) {
      recordLastRun(recordOnId, { at: Date.now(), status: 'cancelled', trigger: cur?.trigger || 'manual' });
    }
    const files = cur?.github?.dispatched;
    if (files?.length) {
      api('/api/pipeline/cancel-run', {
        method: 'POST',
        body: { files, since: new Date(cur.startedAt - 60000).toISOString() },
      }).catch(() => {
        // server unreachable — the GitHub runs will just finish on their own
      });
    }
  };

  const removeWorkflow = (id) => {
    if (run?.id === id) cancelRun();
    const next = workflows.filter((w) => w.id !== id);
    setWorkflows(next);
    saveWorkflows(next);
  };

  // Remember the last run on the workflow itself so the Table Viewer can
  // show which batch each workflow's tables were last populated by.
  const recordLastRun = (id, lastRun) => {
    setWorkflows((ws) => {
      const next = ws.map((w) => (w.id === id ? { ...w, lastRun } : w));
      saveWorkflows(next);
      return next;
    });
  };

  // `trigger` is 'manual' (Run Workflow button) or 'auto' (scheduled run)
  const runWorkflow = async (wf, trigger = 'manual') => {
    const startedAt = Date.now();
    setRun({
      id: wf.id,
      trigger,
      sources: wf.sources,
      sourceStates: Array(wf.sources.length).fill('pending'),
      stageStates: Array(wf.stageCount).fill('pending'),
      github: null,
      githubRuns: null,
      writes: null, // write semantics per step, filled in by the polling effect
      githubDone: false,
      ok: null,
      error: null,
      finished: false,
      startedAt,
    });

    // Kick off the real pipeline on GitHub Actions — one end-to-end
    // orchestrator dispatch per selected feed (stages 1-5 as jobs of that
    // run); IOC dispatches its ingest-only workflow.
    //
    // A bare 5xx/network failure usually means the dev API was mid-restart
    // (node --watch), so retry once before treating it as a real failure.
    // The attached scenario rides along: the server pins the pipeline's
    // shipper scope to its picks before dispatching (none attached = unscoped).
    const trigger12 = () =>
      api('/api/pipeline/trigger-stage12', {
        method: 'POST',
        body: { sources: wf.sources, scenarioId: wf.scenarios?.[0] ?? null },
      });
    try {
      let github;
      try {
        github = await trigger12();
      } catch (err) {
        const transient = /^Request failed \(5|failed to fetch|networkerror/i.test(err.message);
        if (!transient) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        github = await trigger12();
      }
      setRun((r) => ({ ...r, github }));
      localStorage.setItem(
        ACTIVE_RUN_KEY,
        JSON.stringify({
          wfId: wf.id,
          trigger,
          sources: wf.sources,
          stageCount: wf.stageCount,
          github,
          startedAt,
        })
      );
    } catch (err) {
      setRun((r) => ({ ...r, error: `GitHub workflow trigger failed: ${err.message}`, finished: true }));
      recordLastRun(wf.id, { at: Date.now(), status: 'failed', trigger });
      return;
    }
    // From here the run is entirely GitHub-driven: the polling effect below
    // mirrors each feed's run and its stage jobs onto the source and stage
    // pills, and the run finishes when every dispatched run completes.
  };

  // Resume an in-flight dispatch after a page navigation or refresh
  useEffect(() => {
    if (run) return;
    try {
      const saved = JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY));
      if (!saved?.github || Date.now() - saved.startedAt > 2 * 60 * 60 * 1000) return;
      setRun({
        id: saved.wfId,
        trigger: saved.trigger,
        sources: saved.sources,
        sourceStates: Array(saved.sources.length).fill('pending'),
        stageStates: Array(saved.stageCount).fill('pending'),
        github: saved.github,
        githubRuns: null,
        writes: null,
        githubDone: false,
        ok: null,
        error: null,
        finished: false,
        startedAt: saved.startedAt,
      });
    } catch {
      // corrupt saved state — ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scheduler: while the dashboard is open, check every 15s whether a
  // workflow's trigger time has arrived in its own timezone; fire once per day.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const busyRef = useRef(false);
  busyRef.current = isRunning;
  const firedRef = useRef({}); // { [workflowId]: 'YYYY-MM-DD HH:MM' last fired }

  useEffect(() => {
    const tick = () => {
      if (busyRef.current) return;
      for (const wf of workflowsRef.current) {
        if (!wf.schedule) continue;
        const { time, tz } = wf.schedule;
        if (currentTimeIn(tz) !== time) continue;
        const fireKey = `${dateKeyIn(tz)} ${time}`;
        if (firedRef.current[wf.id] === fireKey) continue;
        firedRef.current[wf.id] = fireKey;
        runWorkflow(wf, 'auto');
        break; // one scheduled run at a time
      }
    };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll GitHub every few seconds for the dispatched workflows' run status,
  // so the card updates live while the Actions runs are going. When they all
  // finish, that outcome (not the local simulation) is the run's result.
  const runRef = useRef(null);
  runRef.current = run;

  useEffect(() => {
    const files = run?.github?.dispatched;
    if (!files?.length || run.githubDone) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const cur = runRef.current;
        if (!cur) return;
        // 60s of clock-skew slack; runs older than this are a previous dispatch
        const since = new Date(cur.startedAt - 60000).toISOString();
        // writes=1 also reads the jobs' logs for what each transformation did
        // to its table (appended / preserved / rebuilt / skipped) — the part a
        // bare "completed" hides. Best effort on the server, so a run with no
        // readable logs still tracks normally.
        const res = await api(
          `/api/pipeline/run-status?files=${files.join(',')}&since=${encodeURIComponent(since)}&writes=1`
        );
        if (cancelled) return;
        // One run per dispatched feed; stages 3-5 are jobs INSIDE that run.
        const { runs } = res;
        const entryFor = (key) => runs.find((x) => x.file === SOURCE_FILES[key]);

        // Stage 1 source pills — each feed's ingest job inside its own run
        const sourceStates = cur.sources.map((key) => {
          const e = entryFor(key);
          if (!e?.run) return 'running'; // queued on GitHub
          const job = (e.jobs || []).find((j) => INGEST_JOB_RE.test(j.name));
          return job ? jobState(job.status, job.conclusion) : ghState(e.run.status, e.run.conclusion);
        });

        const started = runs.filter((x) => x.run);
        const allDone =
          started.length === runs.length && started.every((x) => x.run.status === 'completed');
        const anyFailed = started.some(
          (x) => x.run.status === 'completed' && x.run.conclusion !== 'success'
        );

        // Stage 2-5 pills from job names across every feed's run. The combined
        // "stage 1-2 - ingest to bronze" job doubles as the Stage 2 pill; a
        // stage spanning several jobs (stage 5 core/locations/rates + finals)
        // is failed if any failed, done only when ALL are done, running if any
        // is executing or partially complete, otherwise still pending.
        const allJobs = runs.flatMap((x) => x.jobs || []);
        const pillFromJobs = (re) => {
          const hits = allJobs.filter((j) => re.test(j.name));
          if (!hits.length) return 'pending';
          const states = hits.map((j) => jobState(j.status, j.conclusion));
          if (states.includes('failed')) return 'failed';
          if (states.every((s) => s === 'done')) return 'done';
          if (states.includes('running')) return 'running';
          if (states.includes('done')) return 'running'; // partially complete
          return 'pending';
        };
        const stageStates = [
          pillFromJobs(INGEST_JOB_RE),
          pillFromJobs(STAGE_JOB_RE[3]),
          pillFromJobs(STAGE_JOB_RE[4]),
          pillFromJobs(STAGE_JOB_RE[5]),
        ].slice(0, cur.stageStates.length);

        // Lines for the GitHub Actions panel — one per dispatched run
        const githubRuns = runs.map((x) => ({
          key: x.file,
          name: x.run?.name || x.file,
          state: x.run ? ghState(x.run.status, x.run.conclusion) : 'queued',
          url: x.run?.url || null,
        }));

        // The run is over when every dispatched feed's run has completed.
        const done = allDone;
        const ok = done && started.every((x) => x.run.conclusion === 'success');

        // Write semantics for this dispatch, rolled up across every job's log.
        // Absent (older server, unreadable logs) simply means no write block.
        const writes = res.writes || null;

        if (done && !cur.githubDone) {
          recordLastRun(cur.id, {
            at: Date.now(),
            status: ok ? 'success' : 'failed',
            trigger: cur.trigger,
            // Keep the verdict with the run so the card can still say whether
            // anything actually changed after a refresh, not just "completed".
            verdict: runWriteVerdict(writes),
          });
          localStorage.removeItem(ACTIVE_RUN_KEY);
          onPipelineRan?.();
        }
        setRun((r) =>
          r
            ? {
                ...r,
                sourceStates,
                stageStates,
                githubRuns,
                writes: writes || r.writes,
                githubDone: done,
                finished: done ? true : r.finished,
                ok: done ? ok : r.ok,
              }
            : r
        );
      } catch {
        // transient (server restarting, rate limit) — just keep polling
      }
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.github, run?.githubDone]);

  // Re-render once a minute so the "next run in …" countdowns stay current
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((t) => t + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
    {/* ---- Scenarios — created here, attached to workflows below ---- */}
    <div className="panel" style={{ marginBottom: 18 }}>
      <div
        className="workflow-row cc-collapsible-head"
        style={{ marginBottom: scenariosOpen ? 6 : 0 }}
        onClick={toggleScenarios}
        role="button"
        aria-expanded={scenariosOpen}
      >
        <div>
          <span className="eyebrow">Planning</span>
          <h2 style={{ marginBottom: 0 }}>Scenarios</h2>
        </div>
        <span className="cc-collapse-btn" title={scenariosOpen ? 'Collapse' : 'Expand'}>
          {scenariosOpen ? '▾' : '▸'}
        </span>
      </div>
      {scenariosOpen && (
      <>
      <p className="muted" style={{ margin: '4px 0 14px', color: 'var(--slate)' }}>
        A scenario pins one choice per reference data point. Pick from the dropdowns —
        fed by the tables on the <Link to="/reference">Reference Data</Link> tab — save
        the scenario, then attach it to a workflow below and set its automatic times.
        When that workflow runs, the scenario's <strong>shippers</strong> become the
        pipeline's scope: only their contracts pass Stage&nbsp;3. No scenario (or no
        shippers picked) = every shipper passes.
      </p>
      {scenarioError && <div className="status-line err">{scenarioError}</div>}
      <div className="scenario-create">
        <input
          type="text"
          placeholder="Scenario name"
          value={scenarioName}
          onChange={(e) => setScenarioName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createScenario()}
        />
        <input
          type="text"
          className="scenario-desc-input"
          placeholder="Description (optional)"
          value={scenarioDesc}
          onChange={(e) => setScenarioDesc(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createScenario()}
        />
      </div>
      <div className="scenario-rows">
        {SCENARIO_FIELDS.map((f) => {
          const picks = scenarioPicks[f.key] || [''];
          const choices = scenarioOptions?.[f.key] || [];
          return (
            <div key={f.key} className="scenario-field-group">
              <label>{f.label}</label>
              {f.key === 'shipper' && autoShippersRef.current.length > 0 && (
                <span className="scenario-auto-note">
                  {autoShippersRef.current.length} filled in from the selected pipeline
                  {(scenarioPicks.pipeline || []).filter(Boolean).length > 1 ? 's' : ''} — edit freely
                </span>
              )}
              {picks.map((val, i) => (
                <div key={i} className="scenario-row">
                  <select
                    className="scenario-row-value"
                    value={val}
                    onChange={(e) => setPick(f.key, i, e.target.value)}
                  >
                    <option value="">— select —</option>
                    {choices
                      .filter((v) => v === val || !picks.includes(v))
                      .map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                  </select>
                  {picks.length > 1 && (
                    <button
                      type="button"
                      className="cc-remove"
                      title={`Remove this ${f.label.toLowerCase()}`}
                      onClick={() => removePick(f.key, i)}
                    >
                      ✕
                    </button>
                  )}
                  {!f.single && i === picks.length - 1 && (
                    <button
                      type="button"
                      className="scenario-add-row"
                      title={`Add another ${f.label.toLowerCase()}`}
                      disabled={!val || picks.length >= choices.length}
                      onClick={() => addPick(f.key)}
                    >
                      ＋
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ marginBottom: 14 }}>
        <button
          className="btn btn-navy"
          disabled={!scenarioName.trim() || scenarioBusy}
          onClick={createScenario}
        >
          {scenarioBusy ? '⟳ Saving…' : 'Save Scenario'}
        </button>
      </div>
      {scenarios.length > 0 ? (
        <div className="scenario-list">
          {scenarios.map((s) => (
            <div key={s.id} className="scenario-item">
              <div style={{ flex: 1 }}>
                <strong>{s.name}</strong>
                {s.description && <span className="muted"> — {s.description}</span>}
                {s.config && (
                  <div className="scenario-config-summary">
                    {SCENARIO_FIELDS.filter(
                      (f) => s.config[f.key] && s.config[f.key].length
                    ).map((f) => (
                      <span key={f.key}>
                        <em>{f.label}:</em>{' '}
                        {Array.isArray(s.config[f.key])
                          ? s.config[f.key].join(', ')
                          : s.config[f.key]}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="cc-remove"
                title="Delete this scenario"
                onClick={() => deleteScenario(s.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ color: 'var(--slate)', fontSize: '0.8rem', margin: 0 }}>
          No scenarios yet — name one above to create it.
        </p>
      )}
      </>
      )}
    </div>

    <div className="panel">
      <div className="workflow-row" style={{ marginBottom: 16 }}>
        <div>
          <span className="eyebrow">Orchestration</span>
          <h2 style={{ marginBottom: 0 }}>Automatic Workflows</h2>
        </div>
        {!configuring && (
          <button className="btn btn-orange" onClick={() => setConfiguring(true)}>
            + Setup Workflow
          </button>
        )}
      </div>

      {/* ---- Setup / configuration ---- */}
      {configuring && (
        <div className="card wf-config" style={{ marginBottom: 18 }}>
          <h3>Configure a Workflow</h3>
          <p className="muted" style={{ margin: '6px 0 14px' }}>
            Toggle the sources this workflow should pull. Every workflow runs the full
            pipeline — Stage 1 through Stage 5 — for the sources you select.
          </p>
          <div className="field" style={{ maxWidth: 340 }}>
            <label>Workflow name</label>
            <input
              type="text"
              placeholder={`Workflow ${workflows.length + 1}`}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
          </div>

          {/* Scenario to attach (one per workflow) — the reference data
              itself is maintained on the Reference Data tab now */}
          <div className="wf-sources" style={{ marginTop: 16, borderLeftColor: 'var(--navy)' }}>
            <div className="wf-sources-head">
              <strong>Scenario</strong>
              <span className="muted">attach one saved scenario to this workflow</span>
            </div>
            {scenarios.length === 0 ? (
              <p className="muted" style={{ color: 'var(--slate)', fontSize: '0.8rem', margin: 0 }}>
                No scenarios yet — create one in the Scenarios panel above.
              </p>
            ) : (
              <>
                <select
                  className="wf-scenario-select"
                  value={draftScenario}
                  onChange={(e) => setDraftScenario(e.target.value)}
                >
                  <option value="">— no scenario —</option>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.description ? ` — ${s.description}` : ''}
                    </option>
                  ))}
                </select>
                <ScenarioSummary
                  scenario={scenarios.find((s) => String(s.id) === draftScenario)}
                />
              </>
            )}
          </div>

          {/* Source pipelines to retrieve — the only switches on the form */}
          <div className="wf-sources" style={{ marginTop: 16 }}>
            <div className="wf-sources-head">
              <strong>Sources</strong>
              <span className="muted">toggle the source pipelines this workflow should pull</span>
            </div>
            <div className="wf-chip-row">
              {SOURCE_DEFS.map((src) => {
                const selected = draftSources.includes(src.key);
                return (
                  <button
                    key={src.key}
                    type="button"
                    className={`wf-chip ${selected ? 'selected' : ''}`}
                    onClick={() => toggleSource(src.key)}
                  >
                    <span className="wf-chip-check">{selected ? '✓' : '+'}</span>
                    {src.label}
                    <span className="wf-chip-desc">{src.desc}</span>
                  </button>
                );
              })}
            </div>
            {draftSources.length === 0 && (
              <p className="wf-sources-warn">Select at least one source to save this workflow.</p>
            )}
          </div>

          {/* Stages are fixed — every workflow runs the full pipeline */}
          <div className="wf-sources" style={{ marginTop: 16, borderLeftColor: 'var(--navy)' }}>
            <div className="wf-sources-head">
              <strong>Stages that will run</strong>
              <span className="muted">every workflow runs all five stages in order</span>
            </div>
            <div className="step-track" style={{ marginTop: 0 }}>
              {[
                'Stage 1 — API to Raw',
                ...STAGE_DEFS.map((stage) => `${stage.label} — ${stage.desc}`),
              ].map((label, i) => (
                <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {i > 0 && <span className="stage-arrow">→</span>}
                  <span className="step-pill">{label}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Optional scheduled trigger time */}
          <div className="wf-schedule">
            <div className="wf-sources-head" style={{ marginBottom: 8 }}>
              <strong>Trigger time (optional)</strong>
              <span className="muted">run this workflow automatically every day at a set time</span>
            </div>
            <div className="wf-schedule-row">
              <input
                type="time"
                value={draftTime}
                onChange={(e) => setDraftTime(e.target.value)}
              />
              <select value={draftTz} onChange={(e) => setDraftTz(e.target.value)}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz.replaceAll('_', ' ')}</option>
                ))}
              </select>
              {draftTime && (
                <button type="button" className="btn btn-outline" onClick={() => setDraftTime('')}>
                  Clear
                </button>
              )}
            </div>
            <p className="muted" style={{ marginTop: 8, fontSize: '0.78rem', color: 'var(--slate)' }}>
              {draftTime
                ? `Will run daily at ${draftTime} (${draftTz.replaceAll('_', ' ')}) while the dashboard is open.`
                : 'No trigger time set — this workflow will be manual-only. Pick a time above to schedule it.'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button
              className="btn btn-navy"
              disabled={draftSources.length === 0}
              onClick={saveWorkflow}
            >
              Save Workflow
            </button>
            <button className="btn btn-outline" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Configured workflows ---- */}
      {workflows.length === 0 && !configuring && (
        <p className="muted" style={{ color: 'var(--slate)' }}>
          No workflows configured yet — click <strong>Setup Workflow</strong> to choose which
          sources to retrieve and which stages to run.
        </p>
      )}

      {workflows.map((wf) => {
        const thisRun = run?.id === wf.id ? run : null;
        return (
          <div key={wf.id} className="card" style={{ marginBottom: 14 }}>
            {editingId === wf.id ? (
              <>
                <h3 style={{ marginBottom: 10 }}>Edit Workflow</h3>
                <div className="field" style={{ maxWidth: 340 }}>
                  <label>Workflow name</label>
                  <input
                    type="text"
                    value={editDraft.name}
                    onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </div>
                <div className="wf-sources-head" style={{ marginBottom: 8 }}>
                  <strong>Sources</strong>
                  <span className="muted">toggle the source pipelines this workflow should pull</span>
                </div>
                <div className="wf-chip-row" style={{ marginTop: 0 }}>
                  {SOURCE_DEFS.map((src) => {
                    const selected = editDraft.sources.includes(src.key);
                    return (
                      <button
                        key={src.key}
                        type="button"
                        className={`wf-chip ${selected ? 'selected' : ''}`}
                        onClick={() => toggleEditSource(src.key)}
                      >
                        <span className="wf-chip-check">{selected ? '✓' : '+'}</span>
                        {src.label}
                        <span className="wf-chip-desc">{src.desc}</span>
                      </button>
                    );
                  })}
                </div>
                {editDraft.sources.length === 0 && (
                  <p className="wf-sources-warn">Select at least one source.</p>
                )}
                <div className="wf-sources-head" style={{ margin: '20px 0 8px' }}>
                  <strong>Scenario</strong>
                  <span className="muted">attach one saved scenario to this workflow</span>
                </div>
                {scenarios.length === 0 ? (
                  <p className="muted" style={{ color: 'var(--slate)', fontSize: '0.8rem', margin: 0 }}>
                    No scenarios yet — create one in the Scenarios panel above.
                  </p>
                ) : (
                  <>
                    <select
                      className="wf-scenario-select"
                      value={editDraft.scenario}
                      onChange={(e) =>
                        setEditDraft((d) => ({ ...d, scenario: e.target.value }))
                      }
                    >
                      <option value="">— no scenario —</option>
                      {scenarios.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.description ? ` — ${s.description}` : ''}
                        </option>
                      ))}
                    </select>
                    <ScenarioSummary
                      scenario={scenarios.find((s) => String(s.id) === editDraft.scenario)}
                    />
                  </>
                )}
                <div className="wf-sources-head" style={{ margin: '16px 0 8px' }}>
                  <strong>Trigger time</strong>
                  <span className="muted">runs daily at this time — leave empty for manual-only</span>
                </div>
                <div className="wf-schedule-row">
                  <input
                    type="time"
                    value={editDraft.time}
                    onChange={(e) => setEditDraft((d) => ({ ...d, time: e.target.value }))}
                  />
                  <select
                    value={editDraft.tz}
                    onChange={(e) => setEditDraft((d) => ({ ...d, tz: e.target.value }))}
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz.replaceAll('_', ' ')}</option>
                    ))}
                  </select>
                  {editDraft.time && (
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setEditDraft((d) => ({ ...d, time: '' }))}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <button
                    className="btn btn-navy"
                    disabled={editDraft.sources.length === 0}
                    onClick={saveEdit}
                  >
                    Save Changes
                  </button>
                  <button className="btn btn-outline" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
            <>
            <div className="workflow-row">
              <div>
                <h3>
                  {wf.name}{' '}
                  {wf.sources.map((key) => (
                    <span key={key} className="badge manual" style={{ marginLeft: 4 }}>
                      {shortSourceLabel(key)}
                    </span>
                  ))}
                  {wf.stageCount > 0 && (
                    <span className="badge manual" style={{ marginLeft: 4 }}>
                      {wf.stageCount} stage{wf.stageCount > 1 ? 's' : ''}
                    </span>
                  )}
                  {(wf.scenarios || [])
                    .map((id) => scenarios.find((s) => s.id === id))
                    .filter(Boolean)
                    .map((s) => (
                      <span key={s.id} className="badge scenario" style={{ marginLeft: 4 }}>
                        {s.name}
                      </span>
                    ))}
                  {wf.schedule && (
                    <span className="badge scheduled" style={{ marginLeft: 6 }}>
                      scheduled
                    </span>
                  )}
                </h3>
                {wf.schedule ? (
                  <div className="wf-schedule-line">
                    <span className="wf-schedule-clock">🕒</span>
                    Runs daily at <strong>{wf.schedule.time}</strong>
                    <span className="wf-schedule-tz">{wf.schedule.tz.replaceAll('_', ' ')}</span>
                    <span className="wf-schedule-next">
                      next run {nextRunIn(wf.schedule.time, wf.schedule.tz)}
                    </span>
                    <button
                      type="button"
                      className="badge-clear"
                      title="Remove schedule"
                      onClick={() => clearSchedule(wf.id)}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="wf-schedule-line wf-schedule-none">
                    <span className="wf-schedule-clock">🕒</span>
                    No time selected
                  </div>
                )}
                {wf.lastRun ? (
                  <div className={`wf-lastrun ${wf.lastRun.status === 'success' ? 'ok' : 'err'}`}>
                    <span className="wf-lastrun-dot" />
                    Last run{' '}
                    {wf.lastRun.status === 'success'
                      ? 'completed'
                      : wf.lastRun.status === 'cancelled'
                        ? 'cancelled'
                        : 'failed'}{' '}
                    {new Date(wf.lastRun.at).toLocaleString()}
                    {wf.lastRun.trigger && (
                      <span className={`badge ${wf.lastRun.trigger === 'auto' ? 'scheduled' : 'manual'}`}>
                        {wf.lastRun.trigger === 'auto' ? 'automatic run' : 'manual run'}
                      </span>
                    )}
                    {/* "completed" alone can't tell two identical runs apart —
                        carry the verdict so a no-op rerun still reads as one. */}
                    {wf.lastRun.verdict && (
                      <span
                        className={`badge write-verdict-badge ${wf.lastRun.verdict.kind}`}
                        title={wf.lastRun.verdict.detail}
                      >
                        {wf.lastRun.verdict.kind === 'noop' ? 'no new postings' : 'new postings applied'}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="wf-lastrun none">
                    <span className="wf-lastrun-dot" />
                    This workflow hasn't run yet
                  </div>
                )}
                {/* Step pills only appear while a run is in progress (or just finished) */}
                {thisRun && (
                  <>
                    <div className="source-track">
                      <span className="source-track-label">Stage 1 — API to Raw</span>
                      {wf.sources.map((key, j) => {
                        const state = thisRun.sourceStates[j];
                        return (
                          <span key={key} className={`step-pill source-pill ${state}`} title={sourceLabel(key)}>
                            {state === 'running' && <span className="spin">⟳</span>}
                            {state === 'done' && <span className="tick">✓</span>}
                            {state === 'failed' && <span className="tick">✕</span>}
                            {sourceLabel(key)}
                          </span>
                        );
                      })}
                    </div>
                    {wf.stageCount > 0 && (
                      <div className="step-track">
                        {STAGE_DEFS.slice(0, wf.stageCount).map((stage, i) => {
                          const state = thisRun.stageStates[i];
                          return (
                            <span key={stage.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {i > 0 && <span className="stage-arrow">→</span>}
                              <span className={`step-pill ${state}`} title={stage.desc}>
                                {state === 'running' && <span className="spin">⟳</span>}
                                {state === 'done' && <span className="tick">✓</span>}
                                {state === 'failed' && <span className="tick">✕</span>}
                                {stage.label}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn btn-orange"
                  disabled={isRunning}
                  onClick={() => runWorkflow(wf)}
                >
                  {thisRun && isRunning ? (
                    <>
                      <span className="spin">⟳</span> Running…
                    </>
                  ) : (
                    'Run Workflow'
                  )}
                </button>
                {thisRun && isRunning && (
                  <button
                    className="btn btn-outline"
                    onClick={() => cancelRun(wf.id)}
                    title="Stop this run and cancel its GitHub Actions workflows"
                  >
                    ■ Cancel Run
                  </button>
                )}
                <button
                  className="btn btn-outline"
                  disabled={Boolean(thisRun && isRunning)}
                  onClick={() => startEdit(wf)}
                  title="Edit this workflow's sources and trigger time"
                >
                  ✎ Edit
                </button>
                <button
                  className="btn btn-outline"
                  onClick={() => removeWorkflow(wf.id)}
                  title="Remove this workflow (cancels its active run)"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* One panel for the whole run: where it ran, then what it wrote.
                These were separate boxes and read as unrelated reports — the
                write semantics only make sense as detail ON these runs. */}
            {thisRun?.github && (
              <div className="run-detail">
                <div className="run-detail-sec">
                <div className="run-detail-head">⚙ GitHub Actions — live pipeline runs</div>
                {thisRun.github.scope && (
                  <div className={`gh-scope-line ${thisRun.github.scope.scoped ? 'scoped' : ''}`}>
                    {thisRun.github.scope.scoped ? (
                      <>
                        🎯 Scenario <strong>{thisRun.github.scope.scenarioName}</strong> applied —
                        scoped to {thisRun.github.scope.shippers.length} shipper
                        {thisRun.github.scope.shippers.length > 1 ? 's' : ''}:{' '}
                        {thisRun.github.scope.shippers
                          .map((s) => s.name || s.duns)
                          .join(', ')}
                      </>
                    ) : (
                      <>Unscoped run — every shipper passes.</>
                    )}
                    {thisRun.github.scope.unmatched?.length > 0 && (
                      <> (no DUNS found in: {thisRun.github.scope.unmatched.join(', ')})</>
                    )}
                  </div>
                )}
                {(
                  thisRun.githubRuns ||
                  thisRun.github.dispatched.map((f) => ({ key: f, name: f, state: 'queued', url: null }))
                ).map((r) => (
                  <div key={r.key} className={`gh-run-line ${r.state}`}>
                    {r.state === 'done' ? (
                      <span className="tick">✓</span>
                    ) : r.state === 'failed' ? (
                      <span className="tick">✕</span>
                    ) : (
                      <span className="spin">⟳</span>
                    )}
                    <span className="gh-run-name">{r.name}</span>
                    <span>
                      {r.state === 'queued' ? 'queued…' : r.state === 'running' ? 'running…' : r.state}
                    </span>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer">
                        view on GitHub ↗
                      </a>
                    )}
                  </div>
                ))}
                </div>
                {/* What the run did to each table — live, as the jobs execute */}
                <WriteSemantics writes={thisRun.writes} />
              </div>
            )}
            {thisRun?.finished &&
              thisRun.githubDone &&
              !thisRun.error &&
              (thisRun.ok ? (
                <RunOutcome verdict={runWriteVerdict(thisRun.writes)} />
              ) : (
                <div className="status-line err">
                  Pipeline run failed — open the runs above for logs. This workflow run was
                  recorded as failed.
                </div>
              ))}
            {thisRun?.error && <div className="status-line err">{thisRun.error}</div>}
            </>
            )}
          </div>
        );
      })}
    </div>

    {/* ---- Manual workflow (trigger individual pipelines per stage) ---- */}
    <div className="panel">
      <div style={{ marginBottom: 16 }}>
        <span className="eyebrow">Orchestration</span>
        <h2 style={{ marginBottom: 0 }}>Manual Workflow</h2>
      </div>
      <p className="muted" style={{ color: 'var(--slate)', marginBottom: 16 }}>
        Trigger an individual pipeline at any stage, outside of a configured workflow.
      </p>
      <div className="mt-grid">
        <div className="mt-card">
          <div className="mt-stage-head">Stage 1 — API to Raw</div>
          {SOURCE_DEFS.map((src) => (
            <button
              key={src.key}
              className="mt-item"
              disabled={triggering !== null}
              onClick={() => manualTrigger(src)}
            >
              {triggering === src.key ? (
                <span className="spin">⟳</span>
              ) : (
                <span className="mt-item-icon">▶</span>
              )}
              <span>
                {src.label}
                <span className="wf-chip-desc" style={{ display: 'block' }}>{src.desc}</span>
              </span>
            </button>
          ))}
        </div>
        {STAGE_DEFS.map((stage) => (
          <div key={stage.key} className="mt-card disabled">
            <div className="mt-stage-head">
              {stage.label} — {stage.desc}
            </div>
            <div className="mt-coming-soon">Pipeline options coming soon</div>
          </div>
        ))}
      </div>
      {triggerStatus && (
        <div className={`status-line ${triggerStatus.ok ? 'ok' : 'err'}`}>
          {triggerStatus.text}
        </div>
      )}
    </div>
    </>
  );
}
