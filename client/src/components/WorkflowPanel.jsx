import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// Stage 1 (API to Raw) is the source retrieval itself; Stages 2-5 are the
// transformations below. A workflow's stages are always a contiguous prefix
// of this list — you can't run Stage 3 without Stage 2. `apiStage` is the
// pipeline stage number on the server.
const STAGE_DEFS = [
  { key: 2, apiStage: 1, label: 'Stage 2', desc: 'JSON-Bronze' },
  { key: 3, apiStage: 2, label: 'Stage 3', desc: 'Silver Staging (Bronze-To-Silver)' },
  { key: 4, apiStage: 3, label: 'Stage 4', desc: 'Rec-Del Pairing' },
  { key: 5, apiStage: 4, label: 'Stage 5', desc: 'Master Capacity' },
];

// NGH API pipelines the workflow retrieves before its stages run
const SOURCE_DEFS = [
  { key: 'firm', label: 'Firm', desc: 'NGH-gTran-Firms-API-Pipeline' },
  { key: 'interruptible', label: 'Interruptible', desc: 'NGH-gTran-Interruptibles-API-Pipeline' },
  { key: 'awards', label: 'Awards', desc: 'NGH-gExchange-Awards-API-Pipeline' },
  { key: 'index', label: 'Index of Customers', desc: 'NGH-IndexOfCustomers-API-Pipeline' },
];
const ALL_SOURCE_KEYS = SOURCE_DEFS.map((s) => s.key);
const sourceLabel = (key) => SOURCE_DEFS.find((s) => s.key === key)?.label || key;

const STORAGE_KEY = 'pap_workflows_v2';

function loadWorkflows() {
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

function saveWorkflows(workflows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows));
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  const [stageCount, setStageCount] = useState(0); // selected stages = STAGE_DEFS.slice(0, stageCount)
  const [draftSources, setDraftSources] = useState(ALL_SOURCE_KEYS);
  const [draftTime, setDraftTime] = useState(''); // "HH:MM", empty = no schedule
  const [draftTz, setDraftTz] = useState(LOCAL_TZ);

  // Run state:
  // { id, sourceStates: [...], stageStates: [...], error, finished }
  const [run, setRun] = useState(null);
  const isRunning = run !== null && !run.finished && !run.error;

  // Manual workflow triggers
  const [triggering, setTriggering] = useState(null); // source key while a trigger runs
  const [triggerStatus, setTriggerStatus] = useState(null); // { ok, text }

  const manualTrigger = async (src) => {
    setTriggering(src.key);
    setTriggerStatus(null);
    try {
      const result = await api('/api/pipeline/retrieve-source', {
        method: 'POST',
        body: { source: src.key },
      });
      setTriggerStatus({
        ok: true,
        text: `Manual trigger — ${src.label} retrieved ${result.recordCount} records (batch ${result.batchId}).`,
      });
      onPipelineRan?.();
    } catch (err) {
      setTriggerStatus({ ok: false, text: `Manual trigger — ${src.label} failed: ${err.message}` });
    } finally {
      setTriggering(null);
    }
  };

  const toggleStage = (index) => {
    // Clicking an unselected stage selects it plus everything before it;
    // clicking a selected stage deselects it plus everything after it.
    setStageCount((count) => (index < count ? index : index + 1));
  };

  const toggleSource = (key) => {
    setDraftSources((sources) =>
      sources.includes(key) ? sources.filter((s) => s !== key) : [...sources, key]
    );
  };

  const resetForm = () => {
    setConfiguring(false);
    setDraftName('');
    setStageCount(0);
    setDraftSources(ALL_SOURCE_KEYS);
    setDraftTime('');
    setDraftTz(LOCAL_TZ);
  };

  const saveWorkflow = () => {
    if (draftSources.length === 0) return;
    const name = draftName.trim() || `Workflow ${workflows.length + 1}`;
    // Keep sources in pipeline order regardless of click order
    const sources = ALL_SOURCE_KEYS.filter((k) => draftSources.includes(k));
    const schedule = draftTime ? { time: draftTime, tz: draftTz } : null;
    const next = [...workflows, { id: Date.now(), name, stageCount, sources, schedule }];
    setWorkflows(next);
    saveWorkflows(next);
    resetForm();
  };

  const clearSchedule = (id) => {
    const next = workflows.map((w) => (w.id === id ? { ...w, schedule: null } : w));
    setWorkflows(next);
    saveWorkflows(next);
  };

  // Inline "set trigger time" editor on an existing workflow card
  const [editingScheduleId, setEditingScheduleId] = useState(null);
  const [editTime, setEditTime] = useState('');
  const [editTz, setEditTz] = useState(LOCAL_TZ);

  const saveSchedule = (id) => {
    if (!editTime) return;
    const next = workflows.map((w) =>
      w.id === id ? { ...w, schedule: { time: editTime, tz: editTz } } : w
    );
    setWorkflows(next);
    saveWorkflows(next);
    setEditingScheduleId(null);
    setEditTime('');
    setEditTz(LOCAL_TZ);
  };

  const removeWorkflow = (id) => {
    const next = workflows.filter((w) => w.id !== id);
    setWorkflows(next);
    saveWorkflows(next);
    if (run?.id === id) setRun(null);
  };

  const runWorkflow = async (wf) => {
    setRun({
      id: wf.id,
      sourceStates: Array(wf.sources.length).fill('pending'),
      stageStates: Array(wf.stageCount).fill('pending'),
      error: null,
      finished: false,
    });
    const setSourceState = (i, state) =>
      setRun((r) => ({ ...r, sourceStates: r.sourceStates.map((s, j) => (j === i ? state : s)) }));
    const setStageState = (i, state) =>
      setRun((r) => ({ ...r, stageStates: r.stageStates.map((s, j) => (j === i ? state : s)) }));

    // Retrieve each selected source in turn, into the same batch
    let batchId;
    for (let j = 0; j < wf.sources.length; j++) {
      setSourceState(j, 'running');
      try {
        const result = await api('/api/pipeline/retrieve-source', {
          method: 'POST',
          body: { source: wf.sources[j], batchId },
        });
        batchId = result.batchId;
        setSourceState(j, 'done');
      } catch (err) {
        setSourceState(j, 'failed');
        setRun((r) => ({ ...r, error: `Retrieve ${sourceLabel(wf.sources[j])} failed: ${err.message}` }));
        return;
      }
    }

    // Then run the selected stages in order
    for (let i = 0; i < wf.stageCount; i++) {
      const stage = STAGE_DEFS[i];
      setStageState(i, 'running');
      try {
        await api(`/api/pipeline/stage/${stage.apiStage}`, { method: 'POST', body: { batchId } });
        setStageState(i, 'done');
      } catch (err) {
        setStageState(i, 'failed');
        setRun((r) => ({ ...r, error: `${stage.label} failed: ${err.message}` }));
        return;
      }
    }
    setRun((r) => ({ ...r, finished: true }));
    onPipelineRan?.();
  };

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
        runWorkflow(wf);
        break; // one scheduled run at a time
      }
    };
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            Check the source pipelines to retrieve, then pick which stages to run. Stages
            depend on each other, so selecting one automatically includes everything before
            it, and deselecting one removes everything after it.
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

          {/* Source pipelines to retrieve */}
          <div className="wf-sources" style={{ marginTop: 0 }}>
            <div className="wf-sources-head">
              <strong>Stage 1 — API to Raw</strong>
              <span className="muted">check the source pipelines this workflow should pull</span>
            </div>
            <div className="wf-source-list">
              {SOURCE_DEFS.map((src) => (
                <label key={src.key} className="wf-source-item">
                  <input
                    type="checkbox"
                    checked={draftSources.includes(src.key)}
                    onChange={() => toggleSource(src.key)}
                  />
                  <span>
                    {src.label}
                    <span className="wf-chip-desc" style={{ display: 'block' }}>{src.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            {draftSources.length === 0 && (
              <p className="wf-sources-warn">Select at least one source to save this workflow.</p>
            )}
          </div>

          {/* Stage blocks */}
          <div className="wf-chip-row" style={{ marginTop: 16 }}>
            {STAGE_DEFS.map((stage, i) => (
              <button
                key={stage.key}
                type="button"
                className={`wf-chip ${i < stageCount ? 'selected' : ''}`}
                onClick={() => toggleStage(i)}
                title={stage.desc}
              >
                <span className="wf-chip-check">{i < stageCount ? '✓' : '+'}</span>
                {stage.label}
                <span className="wf-chip-desc">{stage.desc}</span>
              </button>
            ))}
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
            <div className="workflow-row">
              <div>
                <h3>
                  {wf.name}{' '}
                  <span className="badge manual">
                    {wf.sources.length} source{wf.sources.length > 1 ? 's' : ''}
                    {wf.stageCount > 0 &&
                      ` · ${wf.stageCount} stage${wf.stageCount > 1 ? 's' : ''}`}
                  </span>
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
                ) : editingScheduleId === wf.id ? (
                  <div className="wf-schedule-row" style={{ marginTop: 8 }}>
                    <input
                      type="time"
                      value={editTime}
                      onChange={(e) => setEditTime(e.target.value)}
                    />
                    <select value={editTz} onChange={(e) => setEditTz(e.target.value)}>
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>{tz.replaceAll('_', ' ')}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-navy"
                      disabled={!editTime}
                      onClick={() => saveSchedule(wf.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setEditingScheduleId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="wf-set-schedule"
                    onClick={() => {
                      setEditingScheduleId(wf.id);
                      setEditTime('');
                      setEditTz(LOCAL_TZ);
                    }}
                  >
                    🕒 Set trigger time
                  </button>
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
                  {thisRun && !thisRun.finished && !thisRun.error ? (
                    <>
                      <span className="spin">⟳</span> Running…
                    </>
                  ) : (
                    'Run Workflow'
                  )}
                </button>
                <button
                  className="btn btn-outline"
                  disabled={isRunning}
                  onClick={() => removeWorkflow(wf.id)}
                  title="Remove this workflow"
                >
                  ✕
                </button>
              </div>
            </div>

            {thisRun?.finished && (
              <div className="wf-complete">
                <span className="wf-complete-icon">✓</span>
                Workflow complete — {wf.sources.length} source
                {wf.sources.length > 1 ? 's' : ''} retrieved
                {wf.stageCount > 0 &&
                  `, ${wf.stageCount} stage${wf.stageCount > 1 ? 's' : ''} finished`}
                .
              </div>
            )}
            {thisRun?.error && <div className="status-line err">{thisRun.error}</div>}
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
