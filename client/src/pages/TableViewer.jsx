import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Header from '../components/Header';
import {
  ALL_SOURCE_KEYS,
  loadWorkflows,
  shortSourceLabel,
  workflowStageSections,
} from '../workflow-defs';

// Icons for the "All Tables" section, keyed by the server's stage names
const STAGE_ICONS = {
  'Stage 1 — API to Raw': '{ }',
  'Stage 2 — JSON-Bronze': '✓',
  'Stage 3 — Silver Staging': '≡',
  'Stage 4 — Rec-Del Pairing': '+',
  'Stage 5 — Master Capacity': 'Σ',
  Logging: '⟳',
  Exceptions: '⚠',
};

// Built-in example so the viewer always has at least one workflow to open
const SAMPLE_WORKFLOW = {
  id: 'sample',
  name: 'Sample Workflow — Full Pipeline',
  sources: ALL_SOURCE_KEYS,
  stageCount: 4,
  sample: true,
};

// Readable stand-in for a table whose label hasn't arrived from the API yet,
// e.g. "index_locations_standardized" -> "IOC Locations Standardized".
function fallbackLabel(name) {
  return name
    .replace(/^index(_|$)/, 'ioc$1')
    .split('_')
    .map((w) => (w === 'ioc' ? 'IOC' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function TableCard({ table, name, icon }) {
  // Render even before /api/tables answers (or if it failed) so cards never
  // vanish — the row count fills in once the data arrives.
  const target = table?.name || name;
  if (!target) return null;
  return (
    <Link to={`/tables/${target}`} style={{ textDecoration: 'none' }}>
      <div className="card table-card table-card-sm">
        <div className="icon-circle icon-circle-sm">{icon}</div>
        <div className="table-card-sm-body">
          <h3>{table?.label || fallbackLabel(target)}</h3>
          <p className="muted">{table ? `${table.rowCount} rows` : '…'}</p>
        </div>
        <span className="table-card-sm-view">View →</span>
      </div>
    </Link>
  );
}

function StageSection({ title, count, grouped, children }) {
  return (
    <div className="tv-stage">
      <div className="tv-stage-head">
        <h3>{title}</h3>
        <span className="stage-tab-count">
          {count} table{count === 1 ? '' : 's'}
        </span>
      </div>
      {grouped ? children : <div className="grid grid-tables-sm">{children}</div>}
    </div>
  );
}

// Stages whose tables are shown as labeled categories inside one section.
// `accent` picks the box color (default navy left border, 'final' = orange).
const STAGE5_GROUPS = [
  { label: 'Firm', accent: 'firm', test: (n) => n.startsWith('firm_') },
  { label: 'Interruptible', test: (n) => n.startsWith('interruptible_') },
  { label: 'Awards', test: (n) => n.startsWith('awards_') },
  { label: 'Final', accent: 'final', test: (n) => n.startsWith('final_') },
];

// Mock NatGasHub API that Stage 1 retrieves from (json--bronze--postgres repo)
const SOURCE_API_BASE = import.meta.env.VITE_SOURCE_API_BASE || 'http://localhost:8000';

const STAGE1_GROUPS = [
  {
    label: 'Firm',
    test: (n) => n === 'raw_firm',
    source: { label: 'Firm Source', url: `${SOURCE_API_BASE}/api/firms` },
  },
  {
    label: 'Interruptible',
    test: (n) => n === 'raw_interruptible',
    source: { label: 'Interruptible Source', url: `${SOURCE_API_BASE}/api/interruptibles` },
  },
  {
    label: 'Awards',
    test: (n) => n === 'raw_awards',
    source: { label: 'Awards Source', url: `${SOURCE_API_BASE}/api/awards` },
  },
  {
    label: 'IOC',
    test: (n) => n === 'raw_index',
    source: { label: 'IOC Source', url: `${SOURCE_API_BASE}/api/ioc` },
  },
];

const STAGE2_GROUPS = [
  { label: 'Firm', test: (n) => n === 'bronze_firm' },
  { label: 'Interruptible', test: (n) => n === 'bronze_interruptible' },
  { label: 'Awards', test: (n) => n === 'bronze_awards' },
  { label: 'IOC', test: (n) => n === 'bronze_index' },
];

// IOC stops after Stage 2, so Stages 3-5 only group the other three sources.
const STAGE3_GROUPS = [
  { label: 'Firm', test: (n) => n.startsWith('firm_') },
  { label: 'Interruptible', test: (n) => n.startsWith('interruptible_') },
  { label: 'Awards', test: (n) => n.startsWith('awards_') },
];

const STAGE4_GROUPS = STAGE3_GROUPS;

function CategorySection({ title, groups, names, tableIndex, icon }) {
  return (
    <StageSection title={title} count={names.length} grouped>
      <div className="tv-groups">
        {groups.map((g) => {
          const members = names.filter((n) => g.test(n));
          if (!members.length) return null;
          return (
            <div key={g.label} className={`tv-group ${g.accent || ''}`}>
              <div className="tv-group-label">
                {g.label}
                {g.source && (
                  <a
                    className="tv-group-source"
                    href={g.source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {g.source.label} ↗
                  </a>
                )}
              </div>
              <div className="grid grid-tables-sm">
                {members.map((n) => (
                  <TableCard key={n} name={n} table={tableIndex[n]} icon={icon} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </StageSection>
  );
}

// Category groups by stage key (workflow view) and stage name (All Tables view)
const GROUPS_BY_KEY = {
  1: STAGE1_GROUPS,
  2: STAGE2_GROUPS,
  3: STAGE3_GROUPS,
  4: STAGE4_GROUPS,
  5: STAGE5_GROUPS,
};
const GROUPS_BY_STAGE = {
  'Stage 1 — API to Raw': STAGE1_GROUPS,
  'Stage 2 — JSON-Bronze': STAGE2_GROUPS,
  'Stage 3 — Silver Staging': STAGE3_GROUPS,
  'Stage 4 — Rec-Del Pairing': STAGE4_GROUPS,
  'Stage 5 — Master Capacity': STAGE5_GROUPS,
};

function WorkflowTables({ wf, tableIndex }) {
  const sections = workflowStageSections(wf);
  const last = wf.lastRun;
  return (
    <div className="wf-acc-body">
      <div className={`tv-run-banner ${last ? (last.status === 'success' ? 'ok' : 'err') : ''}`}>
        <span className="tv-run-dot" />
        {last ? (
          <>
            Last run {last.status === 'success' ? 'completed' : 'failed'}{' '}
            {new Date(last.at).toLocaleString()}
            {last.batchId && <span className="tv-run-batch">batch {last.batchId}</span>}
          </>
        ) : wf.sample ? (
          <>
            Sample workflow — shows every stage's tables. Configure your own on the{' '}
            <Link to="/">dashboard</Link>.
          </>
        ) : (
          <>This workflow hasn't been run yet — run it from the dashboard to populate these tables.</>
        )}
      </div>
      {sections.map((sec) =>
        GROUPS_BY_KEY[sec.key] ? (
          <CategorySection
            key={sec.key}
            title={sec.title}
            groups={GROUPS_BY_KEY[sec.key]}
            names={sec.tables}
            tableIndex={tableIndex}
            icon={sec.icon}
          />
        ) : (
          <StageSection key={sec.key} title={sec.title} count={sec.tables.length}>
            {sec.tables.map((name) => (
              <TableCard key={name} name={name} table={tableIndex[name]} icon={sec.icon} />
            ))}
          </StageSection>
        )
      )}
      {wf.stageCount === 0 && (
        <p className="muted" style={{ marginTop: 18, color: 'var(--slate)' }}>
          This workflow only retrieves sources (Stage 1). Add stages to it on the dashboard to
          see Bronze, Silver, Rec-Del and Master Capacity tables here.
        </p>
      )}
    </div>
  );
}

function WorkflowAccordion({ wf, tableIndex, open, onToggle }) {
  const stageTotal = wf.stageCount + 1; // + Stage 1 retrieval
  return (
    <div className={`wf-acc ${open ? 'open' : ''}`}>
      <button className="wf-acc-head" onClick={onToggle} aria-expanded={open}>
        <span className="wf-acc-chevron">▸</span>
        <span className="wf-acc-title">
          {wf.name}
          {wf.sample && <span className="badge manual" style={{ marginLeft: 8 }}>sample</span>}
          {!wf.sample && !wf.lastRun && (
            <span className="badge manual" style={{ marginLeft: 8 }}>not run yet</span>
          )}
          {wf.lastRun && (
            <span
              className={`badge ${wf.lastRun.status === 'success' ? 'scheduled' : 'manual'}`}
              style={{ marginLeft: 8 }}
            >
              {wf.lastRun.status === 'success' ? 'ran' : 'failed'}
            </span>
          )}
        </span>
        <span className="wf-acc-meta">
          {wf.sources.map(shortSourceLabel).join(' · ')} · {stageTotal} stage
          {stageTotal > 1 ? 's' : ''}
        </span>
      </button>
      {open && <WorkflowTables wf={wf} tableIndex={tableIndex} />}
    </div>
  );
}

export default function TableViewer() {
  const [stages, setStages] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [workflows] = useState(() => [SAMPLE_WORKFLOW, ...loadWorkflows()]);
  const [openId, setOpenId] = useState(null); // workflow id, 'all', or null

  const fetchTables = () => {
    setLoadError(false);
    api('/api/tables')
      .then(({ stages }) => setStages(stages))
      .catch(() => setLoadError(true));
  };
  useEffect(fetchTables, []);

  // name -> { name, label, rowCount } across every stage
  const tableIndex = useMemo(
    () => Object.fromEntries(stages.flatMap((s) => s.tables.map((t) => [t.name, t]))),
    [stages]
  );

  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Data Explorer</div>
          <h1>Table Viewer</h1>
          <p>
            Open a workflow to browse its tables at each pipeline stage, from raw source JSON to
            master capacity.
          </p>
        </div>
      </div>

      <div className="page">
        {loadError && (
          <div className="tv-run-banner err" style={{ marginBottom: 18, marginTop: 0 }}>
            <span className="tv-run-dot" />
            Couldn't load table data — the API may be restarting.
            <button className="btn btn-outline" style={{ marginLeft: 'auto' }} onClick={fetchTables}>
              Retry
            </button>
          </div>
        )}
        <div className="wf-acc-list">
          {workflows.map((wf) => (
            <WorkflowAccordion
              key={wf.id}
              wf={wf}
              tableIndex={tableIndex}
              open={openId === wf.id}
              onToggle={() => toggle(wf.id)}
            />
          ))}

          {/* Everything in the warehouse, including Logging and Exceptions */}
          <div className={`wf-acc ${openId === 'all' ? 'open' : ''}`}>
            <button
              className="wf-acc-head"
              onClick={() => toggle('all')}
              aria-expanded={openId === 'all'}
            >
              <span className="wf-acc-chevron">▸</span>
              <span className="wf-acc-title">All Tables</span>
              <span className="wf-acc-meta">
                {stages.reduce((n, s) => n + s.tables.length, 0)} tables · incl. logging &
                exceptions
              </span>
            </button>
            {openId === 'all' && (
              <div className="wf-acc-body">
                {stages.map((s) =>
                  GROUPS_BY_STAGE[s.stage] ? (
                    <CategorySection
                      key={s.stage}
                      title={s.stage}
                      groups={GROUPS_BY_STAGE[s.stage]}
                      names={s.tables.map((t) => t.name)}
                      tableIndex={tableIndex}
                      icon={STAGE_ICONS[s.stage] || '▦'}
                    />
                  ) : (
                    <StageSection key={s.stage} title={s.stage} count={s.tables.length}>
                      {s.tables.map((t) => (
                        <TableCard key={t.name} table={t} icon={STAGE_ICONS[s.stage] || '▦'} />
                      ))}
                    </StageSection>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
