import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Header from '../components/Header';
import WorkflowPanel from '../components/WorkflowPanel';

const STAGE_INFO = [
  { n: 1, label: 'Stage 1', desc: 'Validation' },
  { n: 2, label: 'Stage 2', desc: 'Normalization' },
  { n: 3, label: 'Stage 3', desc: 'Enrichment' },
  { n: 4, label: 'Stage 4', desc: 'Aggregation' },
  { n: 5, label: 'Stage 5', desc: 'Publish' },
];

const TABLE_ICONS = {
  source_data: '{ }',
  stage1_validated: '✓',
  stage2_normalized: '≡',
  stage3_enriched: '+',
  stage4_aggregated: 'Σ',
  stage5_published: '↗',
  workflow_runs: '⟳',
};

export default function Dashboard() {
  const [tables, setTables] = useState([]);
  const [busy, setBusy] = useState(null); // 'source' | stage number | null
  const [status, setStatus] = useState(null); // { ok, text }

  const refreshTables = useCallback(() => {
    api('/api/tables')
      .then(({ tables }) => setTables(tables))
      .catch((err) => setStatus({ ok: false, text: err.message }));
  }, []);

  useEffect(() => {
    refreshTables();
  }, [refreshTables]);

  const run = async (key, label, request) => {
    setBusy(key);
    setStatus(null);
    try {
      const result = await request();
      setStatus({ ok: true, text: `${label} complete — ${summarize(result)}` });
      refreshTables();
    } catch (err) {
      setStatus({ ok: false, text: `${label} failed: ${err.message}` });
    } finally {
      setBusy(null);
    }
  };

  const retrieveSource = () =>
    run('source', 'Retrieve Source', () =>
      api('/api/pipeline/retrieve-source', { method: 'POST' })
    );

  const runStage = (n) =>
    run(n, `Stage ${n}`, () => api(`/api/pipeline/stage/${n}`, { method: 'POST' }));

  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Data Pipeline Interface</div>
          <h1>Pipeline Operations Dashboard</h1>
          <p>
            Retrieve source JSON, run staged transformations, and orchestrate
            end-to-end workflows — all persisted in Neon.
          </p>
        </div>
      </div>

      <div className="page">
        {/* ---- Pipeline controls ---- */}
        <div className="panel">
          <span className="eyebrow">Manual Operations</span>
          <h2>Run the Pipeline</h2>
          <div className="stage-row">
            <button
              className="btn btn-orange"
              disabled={busy !== null}
              onClick={retrieveSource}
            >
              {busy === 'source' ? <span className="spin">⟳</span> : null} Retrieve Source
            </button>
            {STAGE_INFO.map((s) => (
              <span key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="stage-arrow">→</span>
                <button
                  className="btn btn-navy"
                  disabled={busy !== null}
                  onClick={() => runStage(s.n)}
                  title={s.desc}
                >
                  {busy === s.n ? <span className="spin">⟳</span> : null} {s.label}
                </button>
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--slate)' }}>
            Stages: 1 Validation → 2 Normalization → 3 Enrichment → 4 Aggregation → 5 Publish.
            Each stage reads the previous stage's table for the latest batch.
          </p>
          {status && (
            <div className={`status-line ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>
          )}
        </div>

        {/* ---- Workflows ---- */}
        <WorkflowPanel onPipelineRan={refreshTables} />

        {/* ---- Tables ---- */}
        <h2 className="section-title" style={{ marginTop: 40 }}>
          Database Tables
        </h2>
        <div className="grid grid-tables">
          {tables.map((t) => (
            <Link key={t.name} to={`/tables/${t.name}`} style={{ textDecoration: 'none' }}>
              <div className="card card-center table-card">
                <div className="icon-circle">{TABLE_ICONS[t.name] || '▦'}</div>
                <h3>{t.label}</h3>
                <div className="row-count">{t.rowCount}</div>
                <p className="muted">rows</p>
                <span className="btn btn-orange">View Table</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

function summarize(result) {
  if (result.recordCount !== undefined)
    return `batch ${result.batchId}, ${result.recordCount} records retrieved`;
  if (result.stage !== undefined) {
    const dropped = result.dropped ? `, ${result.dropped} dropped` : '';
    return `batch ${result.batchId}: ${result.in} in → ${result.out} out${dropped}`;
  }
  return JSON.stringify(result);
}
