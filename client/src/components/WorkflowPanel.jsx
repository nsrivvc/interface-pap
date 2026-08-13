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
  const [draftSources, setDraftSources] = useState(ALL_SOURCE_KEYS);
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
  };

  const saveWorkflow = () => {
    if (draftSources.length === 0) return;
    const name = draftName.trim() || `Workflow ${workflows.length + 1}`;
    // Keep sources in pipeline order regardless of click order
    const sources = ALL_SOURCE_KEYS.filter((k) => draftSources.includes(k));
    const schedule = draftTime ? { time: draftTime, tz: draftTz } : null;
    // Every workflow runs the full pipeline: Stage 1 plus all of Stages 2-5
    const next = [...workflows, { id: Date.now(), name, stageCount: STAGE_DEFS.length, sources, schedule }];
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
          }
        : w
    );
    setWorkflows(next);
    saveWorkflows(next);
    cancelEdit();
  };

  const removeWorkflow = (id) => {
    const next = workflows.filter((w) => w.id !== id);
    setWorkflows(next);
    saveWorkflows(next);
    if (run?.id === id) setRun(null);
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
    setRun({
      id: wf.id,
      trigger,
      batchId: null,
      sourceStates: Array(wf.sources.length).fill('pending'),
      stageStates: Array(wf.stageCount).fill('pending'),
      github: null,
      githubRuns: null,
      githubDone: false,
      error: null,
      finished: false,
    });

    // Kick off the real Stage 1/2 ingestion workflows on GitHub Actions —
    // all sources selected dispatches the bronze_ingest orchestrator, a
    // partial selection dispatches each source's own workflow.
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
    } catch (err) {
      setRun((r) => ({ ...r, error: `GitHub workflow trigger failed: ${err.message}` }));
      recordLastRun(wf.id, { at: Date.now(), status: 'failed', trigger });
      return;
    }
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
        setRun((r) => (r ? { ...r, batchId } : r));
        setSourceState(j, 'done');
      } catch (err) {
        setSourceState(j, 'failed');
        setRun((r) => ({ ...r, error: `Retrieve ${sourceLabel(wf.sources[j])} failed: ${err.message}` }));
        recordLastRun(wf.id, { batchId, at: Date.now(), status: 'failed', trigger });
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
        recordLastRun(wf.id, { batchId, at: Date.now(), status: 'failed', trigger });
        return;
      }
    }
    setRun((r) => ({ ...r, finished: true }));
    // Success isn't recorded here — the run only counts as complete once the
    // dispatched GitHub Actions workflows finish (see the polling effect).
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
        const { runs } = await api(`/api/pipeline/stage12-status?files=${files.join(',')}`);
        if (cancelled) return;
        const done = runs.length > 0 && runs.every((x) => x.status === 'completed');
        const cur = runRef.current;
        if (done && cur && !cur.githubDone) {
          const ok = runs.every((x) => x.conclusion === 'success');
          recordLastRun(cur.id, {
            batchId: cur.batchId,
            at: Date.now(),
            status: ok ? 'success' : 'failed',
            trigger: cur.trigger,
          });
        }
        setRun((r) => (r ? { ...r, githubRuns: runs, githubDone: done } : r));
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

          {/* Source pipelines to retrieve — the only switches on the form */}
          <div className="wf-sources" style={{ marginTop: 0 }}>
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
                    Last run {wf.lastRun.status === 'success' ? 'completed' : 'failed'}{' '}
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
                <button
                  className="btn btn-outline"
                  disabled={isRunning}
                  onClick={() => startEdit(wf)}
                  title="Edit this workflow's sources and trigger time"
                >
                  ✎ Edit
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

            {thisRun?.github && (
              <div className="gh-runs">
                <div className="gh-runs-head">⚙ GitHub Actions — {thisRun.github.repo}</div>
                {thisRun.github.dispatched.map((file) => {
                  const info = thisRun.githubRuns?.find((r) => r.file === file);
                  const state =
                    !info || info.status === 'queued'
                      ? 'queued'
                      : info.status === 'in_progress'
                        ? 'running'
                        : info.conclusion === 'success'
                          ? 'done'
                          : 'failed';
                  return (
                    <div key={file} className={`gh-run-line ${state}`}>
                      {state === 'done' ? (
                        <span className="tick">✓</span>
                      ) : state === 'failed' ? (
                        <span className="tick">✕</span>
                      ) : (
                        <span className="spin">⟳</span>
                      )}
                      <span className="gh-run-name">{info?.name || file}</span>
                      <span>
                        {state === 'queued'
                          ? 'queued…'
                          : state === 'running'
                            ? 'running…'
                            : info.conclusion}
                      </span>
                      {info?.url && (
                        <a href={info.url} target="_blank" rel="noreferrer">
                          view on GitHub ↗
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {thisRun?.finished && thisRun.github && !thisRun.githubDone && (
              <div className="status-line ok">
                <span className="spin">⟳</span> Stage 1/2 ingestion is still running on
                GitHub — the workflow completes when it finishes.
              </div>
            )}
            {thisRun?.finished &&
              thisRun.githubDone &&
              (thisRun.githubRuns?.every((r) => r.conclusion === 'success') ? (
                <div className="wf-complete">
                  <span className="wf-complete-icon">✓</span>
                  Workflow complete — {wf.sources.length} source
                  {wf.sources.length > 1 ? 's' : ''} retrieved
                  {wf.stageCount > 0 &&
                    `, ${wf.stageCount} stage${wf.stageCount > 1 ? 's' : ''} finished`}
                  , GitHub ingestion succeeded.
                </div>
              ) : (
                <div className="status-line err">
                  GitHub ingestion failed — open the run above for logs. This workflow run
                  was recorded as failed.
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
