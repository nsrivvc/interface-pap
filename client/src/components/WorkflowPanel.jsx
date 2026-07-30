import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export default function WorkflowPanel({ onPipelineRan }) {
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [runningId, setRunningId] = useState(null);
  const [status, setStatus] = useState(null);
  const [scheduleDraft, setScheduleDraft] = useState({}); // { [id]: minutes }

  const refresh = useCallback(() => {
    api('/api/workflows')
      .then(({ workflows, runs }) => {
        setWorkflows(workflows);
        setRuns(runs);
      })
      .catch((err) => setStatus({ ok: false, text: err.message }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runWorkflow = async (wf) => {
    setRunningId(wf.id);
    setStatus(null);
    try {
      const result = await api(`/api/workflows/${wf.id}/run`, { method: 'POST' });
      if (result.status === 'success') {
        setStatus({
          ok: true,
          text: `Workflow "${wf.name}" finished — batch ${result.batchId}, ${result.log.length} steps. You can now set its schedule below.`,
        });
      } else {
        setStatus({ ok: false, text: `Workflow failed: ${result.error}` });
      }
      refresh();
      onPipelineRan?.();
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    } finally {
      setRunningId(null);
    }
  };

  const saveSchedule = async (wf, enabled) => {
    const minutes = scheduleDraft[wf.id] ?? wf.schedule_minutes ?? '';
    try {
      await api(`/api/workflows/${wf.id}/schedule`, {
        method: 'PUT',
        body: { scheduleMinutes: minutes === '' ? null : Number(minutes), enabled },
      });
      setStatus({
        ok: true,
        text: enabled
          ? `"${wf.name}" scheduled every ${minutes} minute(s).`
          : `Schedule disabled for "${wf.name}".`,
      });
      refresh();
    } catch (err) {
      setStatus({ ok: false, text: err.message });
    }
  };

  return (
    <div className="panel">
      <span className="eyebrow">Orchestration</span>
      <h2>Workflows</h2>

      {workflows.map((wf) => {
        const hasRun = Boolean(wf.last_run_at);
        return (
          <div key={wf.id} className="card" style={{ marginBottom: 14 }}>
            <div className="workflow-row">
              <div>
                <h3>
                  {wf.name}{' '}
                  {wf.enabled && wf.schedule_minutes ? (
                    <span className="badge scheduled">every {wf.schedule_minutes} min</span>
                  ) : (
                    <span className="badge manual">manual</span>
                  )}
                </h3>
                <p className="muted">{wf.description}</p>
                {wf.last_run_at && (
                  <p className="muted">Last run: {new Date(wf.last_run_at).toLocaleString()}</p>
                )}
              </div>
              <button
                className="btn btn-orange"
                disabled={runningId !== null}
                onClick={() => runWorkflow(wf)}
              >
                {runningId === wf.id ? (
                  <>
                    <span className="spin">⟳</span> Running…
                  </>
                ) : (
                  'Activate Workflow'
                )}
              </button>
            </div>

            {/* Scheduling appears once the workflow has completed at least once */}
            {hasRun && (
              <div className="schedule-controls" style={{ marginTop: 16 }}>
                <label style={{ fontSize: '0.82rem', fontWeight: 600 }}>Run every</label>
                <input
                  type="number"
                  min="1"
                  placeholder="min"
                  value={scheduleDraft[wf.id] ?? wf.schedule_minutes ?? ''}
                  onChange={(e) =>
                    setScheduleDraft((d) => ({ ...d, [wf.id]: e.target.value }))
                  }
                />
                <span style={{ fontSize: '0.82rem', color: 'var(--slate)' }}>minutes</span>
                <button className="btn btn-navy" onClick={() => saveSchedule(wf, true)}>
                  Save Schedule
                </button>
                {wf.enabled && (
                  <button className="btn btn-outline" onClick={() => saveSchedule(wf, false)}>
                    Disable
                  </button>
                )}
              </div>
            )}
            {!hasRun && (
              <p className="muted" style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--slate)' }}>
                Run this workflow once to unlock scheduling.
              </p>
            )}
          </div>
        );
      })}

      {status && (
        <div className={`status-line ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>
      )}

      {runs.length > 0 && (
        <>
          <h3 style={{ marginTop: 20, fontSize: '0.95rem' }}>Recent Runs</h3>
          <div className="runs-list">
            {runs.slice(0, 8).map((r) => (
              <div key={r.id} className="run-item">
                <span className={`badge ${r.status}`}>{r.status}</span>
                <span>Run #{r.id}</span>
                {r.batch_id && <span className="muted">batch {r.batch_id}</span>}
                <span className="muted">{new Date(r.started_at).toLocaleString()}</span>
                {r.finished_at && (
                  <span className="muted">
                    {Math.round(
                      (new Date(r.finished_at) - new Date(r.started_at)) / 1000
                    )}
                    s
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
