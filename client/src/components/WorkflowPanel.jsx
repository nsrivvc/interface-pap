import { useEffect, useRef, useState } from 'react';
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

// What a configured shipper does to the feed's raw table. `add` narrows the
// raw table to that DUNS; `remove` drops that DUNS when the feed is processed.
const SHIPPER_ACTIONS = [
  { key: 'add', label: 'Add', hint: 'Filter the raw table to this DUNS' },
  { key: 'remove', label: 'Remove', hint: 'Drop this DUNS from the raw table' },
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

export default function WorkflowPanel({ onPipelineRan }) {
  const [workflows, setWorkflows] = useState(loadWorkflows);

  // Setup form
  const [configuring, setConfiguring] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftSources, setDraftSources] = useState(ALL_SOURCE_KEYS);
  const [draftTime, setDraftTime] = useState(''); // "HH:MM", empty = no schedule
  const [draftTz, setDraftTz] = useState(LOCAL_TZ);
  const [draftPipelines, setDraftPipelines] = useState([]);
  const [draftShippers, setDraftShippers] = useState([]);
  const [draftRecDels, setDraftRecDels] = useState([]);

  // Extra pipelines attached at setup time. Placeholder fields for now —
  // what a pipeline actually points at will be wired up later.
  const addDraftPipeline = () =>
    setDraftPipelines((ps) => [
      ...ps,
      { id: Date.now(), name: '', stage: 3, target: '', notes: '' },
    ]);

  const updateDraftPipeline = (id, patch) =>
    setDraftPipelines((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const removeDraftPipeline = (id) =>
    setDraftPipelines((ps) => ps.filter((p) => p.id !== id));

  // Shippers configured at setup time. Each row is one K-holder plus what to
  // do with it: `add` filters the raw table to that DUNS, `remove` drops it.
  const addDraftShipper = () =>
    setDraftShippers((ss) => [
      ...ss,
      { id: Date.now(), kHolderName: '', kHolderNumber: '', action: 'add' },
    ]);

  const updateDraftShipper = (id, patch) =>
    setDraftShippers((ss) => ss.map((sh) => (sh.id === id ? { ...sh, ...patch } : sh)));

  const removeDraftShipper = (id) =>
    setDraftShippers((ss) => ss.filter((sh) => sh.id !== id));

  // Whether this K-holder is being added to the filter or removed from it.
  const setDraftShipperAction = (id, action) => updateDraftShipper(id, { action });

  // Rec-del pairs attached at setup time. Placeholder fields for now — how a
  // pair feeds the Stage 4 pairing logic will be wired up later.
  const addDraftRecDel = () =>
    setDraftRecDels((rs) => [
      ...rs,
      { id: Date.now(), name: '', receipt: '', delivery: '', notes: '' },
    ]);

  const updateDraftRecDel = (id, patch) =>
    setDraftRecDels((rs) => rs.map((rd) => (rd.id === id ? { ...rd, ...patch } : rd)));

  const removeDraftRecDel = (id) =>
    setDraftRecDels((rs) => rs.filter((rd) => rd.id !== id));

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
    setDraftTime('');
    setDraftTz(LOCAL_TZ);
    setDraftPipelines([]);
    setDraftShippers([]);
    setDraftRecDels([]);
  };

  const saveWorkflow = () => {
    if (draftSources.length === 0) return;
    const name = draftName.trim() || `Workflow ${workflows.length + 1}`;
    // Keep sources in pipeline order regardless of click order
    const sources = ALL_SOURCE_KEYS.filter((k) => draftSources.includes(k));
    const schedule = draftTime ? { time: draftTime, tz: draftTz } : null;
    // Drop pipeline rows the user added but left entirely blank
    const pipelines = draftPipelines.filter((p) => p.name.trim() || p.target.trim());
    // Same for shipper rows — a shipper counts as filled if either field is set
    const shippers = draftShippers.filter(
      (sh) => sh.kHolderName.trim() || sh.kHolderNumber.trim()
    );
    // A pairing row counts as filled if it names either side of the pair
    const recDels = draftRecDels.filter(
      (rd) => rd.name.trim() || rd.receipt.trim() || rd.delivery.trim()
    );
    // Every workflow runs the full pipeline: Stage 1 plus all of Stages 2-5
    const next = [
      ...workflows,
      {
        id: Date.now(),
        name,
        stageCount: STAGE_DEFS.length,
        sources,
        schedule,
        pipelines,
        shippers,
        recDels,
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
      time: wf.schedule?.time || '',
      tz: wf.schedule?.tz || LOCAL_TZ,
      pipelines: wf.pipelines || [],
      shippers: wf.shippers || [],
      recDels: wf.recDels || [],
    });
  };

  // Extra pipelines attached to a workflow. Placeholder fields for now —
  // what a pipeline actually points at will be wired up later.
  const addEditPipeline = () =>
    setEditDraft((d) => ({
      ...d,
      pipelines: [...d.pipelines, { id: Date.now(), name: '', stage: 3, target: '', notes: '' }],
    }));

  const updateEditPipeline = (id, patch) =>
    setEditDraft((d) => ({
      ...d,
      pipelines: d.pipelines.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  const removeEditPipeline = (id) =>
    setEditDraft((d) => ({ ...d, pipelines: d.pipelines.filter((p) => p.id !== id) }));

  // Shippers attached to a workflow. Placeholder fields for now — how a
  // shipper scopes the workflow's data will be wired up later.
  const addEditShipper = () =>
    setEditDraft((d) => ({
      ...d,
      shippers: [
        ...d.shippers,
        { id: Date.now(), kHolderName: '', kHolderNumber: '', action: 'add' },
      ],
    }));

  const updateEditShipper = (id, patch) =>
    setEditDraft((d) => ({
      ...d,
      shippers: d.shippers.map((sh) => (sh.id === id ? { ...sh, ...patch } : sh)),
    }));

  const removeEditShipper = (id) =>
    setEditDraft((d) => ({ ...d, shippers: d.shippers.filter((sh) => sh.id !== id) }));

  // Whether this K-holder is being added to the filter or removed from it.
  const setEditShipperAction = (id, action) => updateEditShipper(id, { action });

  // Rec-del pairs attached to a workflow. Placeholder fields for now — how a
  // pair feeds the Stage 4 pairing logic will be wired up later.
  const addEditRecDel = () =>
    setEditDraft((d) => ({
      ...d,
      recDels: [...d.recDels, { id: Date.now(), name: '', receipt: '', delivery: '', notes: '' }],
    }));

  const updateEditRecDel = (id, patch) =>
    setEditDraft((d) => ({
      ...d,
      recDels: d.recDels.map((rd) => (rd.id === id ? { ...rd, ...patch } : rd)),
    }));

  const removeEditRecDel = (id) =>
    setEditDraft((d) => ({ ...d, recDels: d.recDels.filter((rd) => rd.id !== id) }));

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
            schedule: editDraft.time ? { time: editDraft.time, tz: editDraft.tz } : null,
            // Drop pipeline rows the user added but left entirely blank
            pipelines: editDraft.pipelines.filter((p) => p.name.trim() || p.target.trim()),
            // Same for shipper rows — filled if either field is set
            shippers: editDraft.shippers.filter(
              (sh) => sh.kHolderName.trim() || sh.kHolderNumber.trim()
            ),
            // A pairing row counts as filled if it names either side of the pair
            recDels: editDraft.recDels.filter(
              (rd) => rd.name.trim() || rd.receipt.trim() || rd.delivery.trim()
            ),
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

  // Detach a shipper straight from the workflow card. Shippers saved earlier
  // shouldn't need a trip through the editor just to be removed.
  const removeShipper = (workflowId, shipperId) => {
    const next = workflows.map((w) =>
      w.id === workflowId
        ? { ...w, shippers: (w.shippers || []).filter((sh) => sh.id !== shipperId) }
        : w
    );
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
    const trigger12 = () =>
      api('/api/pipeline/trigger-stage12', { method: 'POST', body: { sources: wf.sources } });
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
        const res = await api(
          `/api/pipeline/run-status?files=${files.join(',')}&since=${encodeURIComponent(since)}`
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

        if (done && !cur.githubDone) {
          recordLastRun(cur.id, {
            at: Date.now(),
            status: ok ? 'success' : 'failed',
            trigger: cur.trigger,
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

          {/* Workflow Components — the optional pieces attached to a workflow.
              All three are placeholders; what each one drives is wired up later. */}
          <div className="wf-group-head">
            <strong>Workflow Components</strong>
            <span className="muted">
              optional pieces attached to this workflow — what each one drives will be
              configured later
            </span>
          </div>

          {/* Additional pipelines — placeholder fields, parameters wired up later */}
          <div className="wf-sources" style={{ marginTop: 0, borderLeftColor: 'var(--navy)' }}>
            <div className="wf-sources-head">
              <strong>Pipelines</strong>
              <span className="muted">
                attach additional pipelines to this workflow — what they run will be
                configured later
              </span>
            </div>
            {draftPipelines.length === 0 && (
              <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                No pipelines added yet.
              </p>
            )}
            {draftPipelines.map((p) => (
              <div key={p.id} className="wf-pipeline-row">
                <input
                  type="text"
                  placeholder="Pipeline name"
                  value={p.name}
                  onChange={(e) => updateDraftPipeline(p.id, { name: e.target.value })}
                />
                <select
                  value={p.stage}
                  onChange={(e) => updateDraftPipeline(p.id, { stage: Number(e.target.value) })}
                  title="The stage this pipeline runs at"
                >
                  <option value={1}>Stage 1 — API to Raw</option>
                  {STAGE_DEFS.map((stage) => (
                    <option key={stage.key} value={stage.key}>
                      {stage.label} — {stage.desc}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="wf-pipeline-target"
                  placeholder="Target (workflow file, endpoint, script…)"
                  value={p.target}
                  onChange={(e) => updateDraftPipeline(p.id, { target: e.target.value })}
                />
                <input
                  type="text"
                  className="wf-pipeline-notes"
                  placeholder="Notes (optional)"
                  value={p.notes}
                  onChange={(e) => updateDraftPipeline(p.id, { notes: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-outline"
                  title="Remove this pipeline"
                  onClick={() => removeDraftPipeline(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-outline" onClick={addDraftPipeline}>
              + Add Pipeline
            </button>
          </div>

          {/* Shippers — placeholder fields, scoping wired up later */}
          <div className="wf-sources" style={{ marginTop: 16, borderLeftColor: 'var(--navy)' }}>
            <div className="wf-sources-head">
              <strong>Shippers</strong>
              <span className="muted">
                attach shippers to this workflow — how they scope the data will be
                configured later
              </span>
            </div>
            <p className="wf-note">
              Adding a shipper filters the raw table to that DUNS. Removing one drops that
              DUNS from the raw table the next time the feed is processed.
            </p>
            {draftShippers.length === 0 && (
              <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                No shippers configured yet.
              </p>
            )}
            {draftShippers.map((sh) => (
              <div key={sh.id} className="wf-pipeline-row">
                <input
                  type="text"
                  placeholder="KHolderName"
                  value={sh.kHolderName}
                  onChange={(e) => updateDraftShipper(sh.id, { kHolderName: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="KHolderNumber"
                  value={sh.kHolderNumber}
                  onChange={(e) => updateDraftShipper(sh.id, { kHolderNumber: e.target.value })}
                />
                <span className="wf-action-toggle" role="group" aria-label="Shipper action">
                  {SHIPPER_ACTIONS.map((a) => (
                    <button
                      key={a.key}
                      type="button"
                      className={`wf-action-btn ${sh.action === a.key ? 'selected' : ''}`}
                      title={a.hint}
                      onClick={() => setDraftShipperAction(sh.id, a.key)}
                    >
                      {a.label}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  className="btn btn-outline wf-row-remove"
                  title="Discard this row"
                  onClick={() => removeDraftShipper(sh.id)}
                >
                  ✕ Discard
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-outline" onClick={addDraftShipper}>
              + Configure Shipper
            </button>
          </div>

          {/* Rec-del pairs — placeholder fields, Stage 4 wiring comes later */}
          <div className="wf-sources" style={{ marginTop: 16, borderLeftColor: 'var(--navy)' }}>
            <div className="wf-sources-head">
              <strong>Rec-Del Pairings</strong>
              <span className="muted">
                pair receipt and delivery locations for Stage 4 — how they feed the pairing
                logic will be configured later
              </span>
            </div>
            {draftRecDels.length === 0 && (
              <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                No rec-del pairings added yet.
              </p>
            )}
            {draftRecDels.map((rd) => (
              <div key={rd.id} className="wf-pipeline-row">
                <input
                  type="text"
                  placeholder="Pairing name"
                  value={rd.name}
                  onChange={(e) => updateDraftRecDel(rd.id, { name: e.target.value })}
                />
                <input
                  type="text"
                  className="wf-pipeline-target"
                  placeholder="Receipt location"
                  value={rd.receipt}
                  onChange={(e) => updateDraftRecDel(rd.id, { receipt: e.target.value })}
                />
                <input
                  type="text"
                  className="wf-pipeline-target"
                  placeholder="Delivery location"
                  value={rd.delivery}
                  onChange={(e) => updateDraftRecDel(rd.id, { delivery: e.target.value })}
                />
                <input
                  type="text"
                  className="wf-pipeline-notes"
                  placeholder="Notes (optional)"
                  value={rd.notes}
                  onChange={(e) => updateDraftRecDel(rd.id, { notes: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-outline wf-row-remove"
                  title="Remove this pairing"
                  onClick={() => removeDraftRecDel(rd.id)}
                >
                  ✕ Remove Pairing
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-outline" onClick={addDraftRecDel}>
              + Add Rec-Del Pairing
            </button>
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
                <div className="wf-group-head" style={{ margin: '20px 0 4px' }}>
                  <strong>Workflow Components</strong>
                  <span className="muted">
                    optional pieces attached to this workflow — what each one drives will be
                    configured later
                  </span>
                </div>
                <div className="wf-sources-head" style={{ margin: '16px 0 8px' }}>
                  <strong>Pipelines</strong>
                  <span className="muted">
                    attach additional pipelines to this workflow — what they run will be
                    configured later
                  </span>
                </div>
                {editDraft.pipelines.length === 0 && (
                  <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                    No pipelines added yet.
                  </p>
                )}
                {editDraft.pipelines.map((p) => (
                  <div key={p.id} className="wf-pipeline-row">
                    <input
                      type="text"
                      placeholder="Pipeline name"
                      value={p.name}
                      onChange={(e) => updateEditPipeline(p.id, { name: e.target.value })}
                    />
                    <select
                      value={p.stage}
                      onChange={(e) => updateEditPipeline(p.id, { stage: Number(e.target.value) })}
                      title="The stage this pipeline runs at"
                    >
                      <option value={1}>Stage 1 — API to Raw</option>
                      {STAGE_DEFS.map((stage) => (
                        <option key={stage.key} value={stage.key}>
                          {stage.label} — {stage.desc}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      className="wf-pipeline-target"
                      placeholder="Target (workflow file, endpoint, script…)"
                      value={p.target}
                      onChange={(e) => updateEditPipeline(p.id, { target: e.target.value })}
                    />
                    <input
                      type="text"
                      className="wf-pipeline-notes"
                      placeholder="Notes (optional)"
                      value={p.notes}
                      onChange={(e) => updateEditPipeline(p.id, { notes: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-outline"
                      title="Remove this pipeline"
                      onClick={() => removeEditPipeline(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-outline" onClick={addEditPipeline}>
                  + Add Pipeline
                </button>
                <div className="wf-sources-head" style={{ margin: '16px 0 8px' }}>
                  <strong>Shippers</strong>
                  <span className="muted">
                    attach shippers to this workflow — how they scope the data will be
                    configured later
                  </span>
                </div>
                <p className="wf-note">
                  Adding a shipper filters the raw table to that DUNS. Removing one drops that
                  DUNS from the raw table the next time the feed is processed.
                </p>
                {editDraft.shippers.length === 0 && (
                  <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                    No shippers configured yet.
                  </p>
                )}
                {editDraft.shippers.map((sh) => (
                  <div key={sh.id} className="wf-pipeline-row">
                    <input
                      type="text"
                      placeholder="KHolderName"
                      value={sh.kHolderName}
                      onChange={(e) => updateEditShipper(sh.id, { kHolderName: e.target.value })}
                    />
                    <input
                      type="text"
                      placeholder="KHolderNumber"
                      value={sh.kHolderNumber}
                      onChange={(e) => updateEditShipper(sh.id, { kHolderNumber: e.target.value })}
                    />
                    <span className="wf-action-toggle" role="group" aria-label="Shipper action">
                      {SHIPPER_ACTIONS.map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          className={`wf-action-btn ${sh.action === a.key ? 'selected' : ''}`}
                          title={a.hint}
                          onClick={() => setEditShipperAction(sh.id, a.key)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline wf-row-remove"
                      title="Discard this row"
                      onClick={() => removeEditShipper(sh.id)}
                    >
                      ✕ Discard
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-outline" onClick={addEditShipper}>
                  + Configure Shipper
                </button>
                <div className="wf-sources-head" style={{ margin: '16px 0 8px' }}>
                  <strong>Rec-Del Pairings</strong>
                  <span className="muted">
                    pair receipt and delivery locations for Stage 4 — how they feed the pairing
                    logic will be configured later
                  </span>
                </div>
                {editDraft.recDels.length === 0 && (
                  <p className="muted" style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--slate)' }}>
                    No rec-del pairings added yet.
                  </p>
                )}
                {editDraft.recDels.map((rd) => (
                  <div key={rd.id} className="wf-pipeline-row">
                    <input
                      type="text"
                      placeholder="Pairing name"
                      value={rd.name}
                      onChange={(e) => updateEditRecDel(rd.id, { name: e.target.value })}
                    />
                    <input
                      type="text"
                      className="wf-pipeline-target"
                      placeholder="Receipt location"
                      value={rd.receipt}
                      onChange={(e) => updateEditRecDel(rd.id, { receipt: e.target.value })}
                    />
                    <input
                      type="text"
                      className="wf-pipeline-target"
                      placeholder="Delivery location"
                      value={rd.delivery}
                      onChange={(e) => updateEditRecDel(rd.id, { delivery: e.target.value })}
                    />
                    <input
                      type="text"
                      className="wf-pipeline-notes"
                      placeholder="Notes (optional)"
                      value={rd.notes}
                      onChange={(e) => updateEditRecDel(rd.id, { notes: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-outline wf-row-remove"
                      title="Remove this pairing"
                      onClick={() => removeEditRecDel(rd.id)}
                    >
                      ✕ Remove Pairing
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-outline" onClick={addEditRecDel}>
                  + Add Rec-Del Pairing
                </button>
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
                  {wf.pipelines?.length > 0 && (
                    <span className="badge manual" style={{ marginLeft: 4 }}>
                      {wf.pipelines.length} pipeline{wf.pipelines.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {wf.shippers?.length > 0 && (
                    <span className="badge manual" style={{ marginLeft: 4 }}>
                      {wf.shippers.length} shipper{wf.shippers.length > 1 ? 's' : ''}
                    </span>
                  )}
                  {wf.recDels?.length > 0 && (
                    <span className="badge manual" style={{ marginLeft: 4 }}>
                      {wf.recDels.length} pairing{wf.recDels.length > 1 ? 's' : ''}
                    </span>
                  )}
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
                {wf.shippers?.length > 0 && (
                  <div className="wf-attached-line">
                    <span className="wf-attached-label">Shippers</span>
                    {wf.shippers.map((sh) => (
                      <span key={sh.id} className="wf-attached-chip">
                        <span className={`wf-attached-sign ${sh.action === 'remove' ? 'out' : 'in'}`}>
                          {sh.action === 'remove' ? '−' : '+'}
                        </span>
                        {sh.kHolderName || sh.kHolderNumber || 'Unnamed shipper'}
                        {sh.kHolderName && sh.kHolderNumber && (
                          <span className="wf-attached-meta">{sh.kHolderNumber}</span>
                        )}
                        <button
                          type="button"
                          className="badge-clear"
                          title={`Remove ${sh.kHolderName || 'this shipper'}`}
                          onClick={() => removeShipper(wf.id, sh.id)}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
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

            {thisRun?.github && (
              <div className="gh-runs">
                <div className="gh-runs-head">⚙ GitHub Actions — live pipeline runs</div>
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
            )}
            {thisRun?.finished &&
              thisRun.githubDone &&
              !thisRun.error &&
              (thisRun.ok ? (
                <div className="wf-complete">
                  <span className="wf-complete-icon">✓</span>
                  Workflow complete — every pipeline stage finished successfully.
                </div>
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
