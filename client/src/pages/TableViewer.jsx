import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Header from '../components/Header';

const STAGE_ICONS = {
  'Stage 1 — API to Raw': '{ }',
  'Stage 2 — JSON-Bronze': '✓',
  'Stage 3 — Silver Staging': '≡',
  'Stage 4 — Rec-Del Pairing': '+',
  'Stage 5 — Master Capacity': 'Σ',
  Operations: '⟳',
};

export default function TableViewer() {
  const [stages, setStages] = useState([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    api('/api/tables')
      .then(({ stages }) => setStages(stages))
      .catch(() => {});
  }, []);

  const current = stages[active];

  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Data Explorer</div>
          <h1>Table Viewer</h1>
          <p>Browse the tables behind each pipeline stage, from raw source JSON to master capacity.</p>
        </div>
      </div>

      <div className="page">
        {/* ---- Stage tabs ---- */}
        <div className="stage-tabs">
          {stages.map((s, i) => (
            <button
              key={s.stage}
              className={`stage-tab ${i === active ? 'active' : ''}`}
              onClick={() => setActive(i)}
            >
              {s.stage}
              <span className="stage-tab-count">
                {s.tables.length} table{s.tables.length > 1 ? 's' : ''}
              </span>
            </button>
          ))}
        </div>

        {/* ---- Tables in the selected stage ---- */}
        {current && (
          <div className="grid grid-tables" style={{ marginTop: 24 }}>
            {current.tables.map((t) => (
              <Link key={t.name} to={`/tables/${t.name}`} style={{ textDecoration: 'none' }}>
                <div className="card card-center table-card">
                  <div className="icon-circle">{STAGE_ICONS[current.stage] || '▦'}</div>
                  <h3>{t.label}</h3>
                  <p className="muted">{t.rowCount} rows</p>
                  <span className="btn btn-orange">View Table</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
