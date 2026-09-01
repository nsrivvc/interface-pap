// The Reference Data tab's UI, in three building blocks:
//   Section        — a collapsible block (open/closed remembered per browser)
//   SourceConfig   — pick the source API, enter credentials, test connections
//   ComponentTable — one editable AG Grid over a reference warehouse table
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import { api, apiDownload } from '../api';
import { gridTheme } from '../grid-theme';

// ---- Configure Components ----
// Each component is a real warehouse table shown in the same AG Grid the
// Table Viewer uses, with AG Grid's own editing doing the data entry:
//  - the striped row pinned to the bottom of each grid (right above its Add
//    button) is the INPUT row — click it, type the values, then hit ＋ (or the
//    Add button) to insert;
//  - any existing cell is editable in place (click it) — committing the row
//    (Enter / clicking away) saves the change straight to the table.
// Columns come from the live table, so a column added in Neon shows up here
// automatically.

const isNumeric = (dataType) => /int|numeric|double|real/.test(dataType || '');

// bigint/numeric columns come back from Postgres as strings — turn them back
// into numbers wherever we show or export them (DUNS: 0, not "0").
const numify = (col, v) =>
  isNumeric(col.dataType) && v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v))
    ? Number(v)
    : v;

const blank = (v) => v === undefined || v === null || v === '';

// Reference tables have no Parquet export — the pipeline doesn't produce them.
const DOWNLOAD_FORMATS = ['csv', 'xlsx'];

function ComponentTable({ tableKey, viewerName, addLabel }) {
  const [data, setData] = useState(null); // { columns, rows }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(null); // format while a download runs

  // The pinned input row. AG Grid writes committed cell values straight onto
  // this object; the tick just re-renders so the Add button enables/disables.
  const draftRef = useRef({});
  const [, setDraftTick] = useState(0);
  // Row snapshot taken when an existing row enters edit mode, so we only save
  // the fields that actually changed (the grid mutates our row objects).
  const editSnapshot = useRef(null);

  const load = useCallback(() => {
    api(`/api/components/${tableKey}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [tableKey]);
  useEffect(load, [load]);

  const editableCols = useMemo(() => (data?.columns || []).filter((c) => !c.auto), [data]);

  // Commit the pinned input row as a new table row
  const addFromDraft = useCallback(async () => {
    const values = {};
    for (const c of editableCols) {
      const v = (draftRef.current[c.name] ?? '').toString().trim();
      if (v !== '') values[c.name] = v;
    }
    if (!Object.keys(values).length || saving) return;
    setSaving(true);
    setError('');
    try {
      await api(`/api/components/${tableKey}`, { method: 'POST', body: { values } });
      draftRef.current = {};
      setDraftTick((t) => t + 1);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [tableKey, editableCols, saving, load]);

  const removeRow = useCallback(
    async (row) => {
      try {
        await api(`/api/components/${tableKey}`, { method: 'DELETE', body: { ctid: row._ctid } });
        load();
      } catch (err) {
        setError(err.message);
      }
    },
    [tableKey, load]
  );

  // An existing row finished inline editing — save only the changed fields
  const onRowValueChanged = useCallback(
    async (e) => {
      if (e.node.rowPinned) return;
      const before = editSnapshot.current || {};
      editSnapshot.current = null;
      const changed = {};
      for (const c of (data?.columns || []).filter((col) => !col.auto)) {
        const now = e.data[c.name];
        if (String(now ?? '') !== String(before[c.name] ?? '')) {
          changed[c.name] = blank(now) ? null : now;
        }
      }
      if (!Object.keys(changed).length) return;
      try {
        await api(`/api/components/${tableKey}`, {
          method: 'PUT',
          body: { ctid: e.data._ctid, values: changed },
        });
        setError('');
      } catch (err) {
        setError(err.message);
      }
      load(); // ctids change on UPDATE — always refetch the canonical rows
    },
    [tableKey, data, load]
  );

  const columnDefs = useMemo(() => {
    if (!data) return [];
    // The input row announces itself in its first cell ("＋ Add … — type here")
    const firstEditable = data.columns.find((col) => !col.auto)?.name;
    const addHint = `＋ ${addLabel.replace(/^\+\s*/, '')} — type here…`;
    return [
      ...data.columns.map((c) => ({
        field: c.name,
        headerName: c.name,
        sortable: true,
        filter: true,
        resizable: true,
        flex: 1,
        minWidth: c.auto ? 80 : 130,
        maxWidth: c.auto ? 90 : undefined,
        editable: !c.auto,
        valueGetter: (p) => numify(c, p.data?.[c.name]),
        // The empty input row shows "＋ Add … — type here" in its first cell
        // and each column's name as the placeholder in the rest
        valueFormatter: (p) => {
          if (p.node?.rowPinned) {
            if (!blank(p.value)) return String(p.value);
            if (c.auto) return '';
            return c.name === firstEditable ? addHint : `${c.name}…`;
          }
          return blank(p.value) ? '' : String(p.value);
        },
        cellClassRules: {
          'cc-input-placeholder': (p) => Boolean(p.node?.rowPinned) && blank(p.value),
          'cc-input-hint': (p) =>
            Boolean(p.node?.rowPinned) && blank(p.value) && c.name === firstEditable,
        },
      })),
      {
        colId: 'actions',
        headerName: '',
        width: 60,
        sortable: false,
        filter: false,
        resizable: false,
        editable: false,
        cellRenderer: (p) =>
          p.node.rowPinned ? (
            <button
              type="button"
              className="cc-add-inline"
              title={addLabel}
              onClick={addFromDraft}
            >
              ＋
            </button>
          ) : (
            <button
              type="button"
              className="cc-remove"
              title="Remove this row"
              onClick={() => removeRow(p.data)}
            >
              ✕
            </button>
          ),
      },
    ];
  }, [data, addLabel, addFromDraft, removeRow]);

  const draftFilled = editableCols.some(
    (c) => (draftRef.current[c.name] ?? '').toString().trim() !== ''
  );

  // Every row of the backing table, straight from the same download route the
  // Table Viewer uses (all rows, not just the page on screen).
  const download = async (format) => {
    setDownloading(format);
    setError('');
    try {
      await apiDownload(`/api/tables/${viewerName}/download?format=${format}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(null);
    }
  };

  if (!data && !error) {
    return <p className="muted cc-loading">Loading table…</p>;
  }

  return (
    <>
      {error && <div className="status-line err">{error}</div>}
      {data && (
        <>
          <div className="cc-grid">
            <AgGridReact
              theme={gridTheme}
              rowData={data.rows}
              columnDefs={columnDefs}
              pinnedTopRowData={[]}
              pinnedBottomRowData={[draftRef.current]}
              editType="fullRow"
              singleClickEdit
              stopEditingWhenCellsLoseFocus
              onRowEditingStarted={(e) => {
                if (!e.node.rowPinned) editSnapshot.current = { ...e.data };
              }}
              onRowValueChanged={onRowValueChanged}
              onCellValueChanged={(e) => {
                if (e.node.rowPinned === 'bottom') setDraftTick((t) => t + 1);
              }}
              domLayout="autoHeight"
              pagination={data.rows.length > 10}
              paginationPageSize={10}
              paginationPageSizeSelector={[10, 25, 50]}
              enableCellTextSelection
              overlayNoRowsTemplate="<span style='padding: 14px; color: #6b7487;'>No rows yet — type into the input row below to add the first one.</span>"
            />
          </div>
          <div className="cc-add-row">
            <button
              type="button"
              className="btn btn-navy"
              disabled={saving || !draftFilled}
              onClick={addFromDraft}
              title="Insert the values typed into the input row above"
            >
              {saving ? '⟳ Adding…' : addLabel}
            </button>
            {viewerName && (
              <div className="dl-group">
                <span className="dl-label">Download</span>
                {DOWNLOAD_FORMATS.map((format) => (
                  <button
                    key={format}
                    type="button"
                    className="btn btn-outline dl-btn"
                    disabled={downloading !== null}
                    onClick={() => download(format)}
                    title={`Download every row of this table as ${format.toUpperCase()}`}
                  >
                    {downloading === format ? <span className="spin">⟳</span> : '↓'}{' '}
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            {viewerName && (
              <Link className="cc-viewer-link" to={`/tables/${viewerName}`}>
                open in Table Viewer →
              </Link>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---- Collapsible section ----
// Every Configure Components block tucks away behind the arrow in its header
// (the whole header toggles). The open/closed choice sticks per browser via
// localStorage, and a collapsed grid doesn't fetch until first expanded.
function Section({ id, title, hint, defaultOpen = false, right, first, children }) {
  const storageKey = `cc-open:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultOpen : stored === '1';
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(storageKey, o ? '0' : '1');
      } catch {
        // storage unavailable — the section still toggles, just isn't remembered
      }
      return !o;
    });
  return (
    <div className={first ? undefined : 'cc-section'}>
      <div
        className="wf-sources-head cc-collapsible-head"
        style={open ? undefined : { marginBottom: 0 }}
        onClick={toggle}
        role="button"
        aria-expanded={open}
      >
        <strong>{title}</strong>
        <span className="muted">{hint}</span>
        {right}
        <span className="cc-collapse-btn" title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </span>
      </div>
      {open && children}
    </div>
  );
}

// ---- Configure Source ----
// Which upstream API the workflow's source JSONs come from — a single-row
// warehouse setting (public.source_config) saved the moment an option is
// picked. NatGasHub and Cortex take per-source credentials (base URL +
// key/username), verified against the API the moment they are saved; the
// outcome shows as a connected/failed badge on the card. Configuration only
// for now: retrieval still runs against the Mock-Up NatGasHub API until the
// other sources are wired up.
function SourceConfig() {
  const [config, setConfig] = useState(null); // { source, options }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const radioGroup = useId(); // two ComponentsConfig instances can be mounted

  // Credentials editor — which source's form is open, its draft and progress
  const [credOpen, setCredOpen] = useState('');
  const [credDraft, setCredDraft] = useState({ baseUrl: '', username: '', apiKey: '' });
  const [credBusy, setCredBusy] = useState(''); // '' | 'save' | 'verify' | 'remove'
  const [credError, setCredError] = useState('');

  useEffect(() => {
    api('/api/source-config')
      .then((d) => {
        setConfig(d);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, []);

  // Test the SELECTED source's connection — the mock is pinged directly, the
  // real sources are re-verified with their stored credentials.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { label, status, detail }

  const testSelected = async () => {
    if (!config || testing) return;
    const opt = config.options.find((o) => o.key === config.source);
    setTesting(true);
    setTestResult(null);
    try {
      const { connection } = await api(`/api/source-config/${config.source}/verify`, {
        method: 'POST',
      });
      if (opt?.needsCredentials) applyConnection(config.source, connection);
      setTestResult({ label: opt?.label, status: connection.status, detail: connection.detail });
    } catch (err) {
      setTestResult({ label: opt?.label, status: 'failed', detail: err.message });
    } finally {
      setTesting(false);
    }
  };

  const choose = async (key) => {
    if (!config || key === config.source || saving) return;
    const prev = config.source;
    setConfig({ ...config, source: key });
    setCredOpen(''); // credentials belong to the selected source — close any open form
    setTestResult(null);
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      await api('/api/source-config', { method: 'PUT', body: { source: key } });
      setSaved(true);
    } catch (err) {
      setConfig((c) => ({ ...c, source: prev }));
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const applyConnection = (key, connection) =>
    setConfig((c) => ({
      ...c,
      options: c.options.map((o) => (o.key === key ? { ...o, connection } : o)),
    }));

  const toggleCreds = (key) => {
    if (credOpen === key) {
      setCredOpen('');
      return;
    }
    const conn = config?.options.find((o) => o.key === key)?.connection;
    setCredDraft({ baseUrl: conn?.baseUrl || '', username: conn?.username || '', apiKey: '' });
    setCredError('');
    setCredOpen(key);
  };

  const saveCreds = async () => {
    if (credBusy) return;
    setCredBusy('save');
    setCredError('');
    try {
      const { connection } = await api(`/api/source-config/${credOpen}/credentials`, {
        method: 'PUT',
        body: credDraft,
      });
      applyConnection(credOpen, connection);
      setCredDraft((d) => ({ ...d, apiKey: '' })); // the key now lives server-side only
    } catch (err) {
      setCredError(err.message);
    } finally {
      setCredBusy('');
    }
  };

  const testCreds = async () => {
    if (credBusy) return;
    setCredBusy('verify');
    setCredError('');
    try {
      const { connection } = await api(`/api/source-config/${credOpen}/verify`, {
        method: 'POST',
      });
      applyConnection(credOpen, connection);
    } catch (err) {
      setCredError(err.message);
    } finally {
      setCredBusy('');
    }
  };

  const removeCreds = async () => {
    if (credBusy) return;
    setCredBusy('remove');
    setCredError('');
    try {
      await api(`/api/source-config/${credOpen}/credentials`, { method: 'DELETE' });
      applyConnection(credOpen, {
        configured: false,
        status: null,
        detail: null,
        verifiedAt: null,
        baseUrl: '',
        username: '',
        hasKey: false,
      });
      setCredDraft({ baseUrl: '', username: '', apiKey: '' });
    } catch (err) {
      setCredError(err.message);
    } finally {
      setCredBusy('');
    }
  };

  const badge = (o) => {
    if (!o.needsCredentials) return null;
    const conn = o.connection;
    if (conn?.status === 'connected') {
      return (
        <span className="cc-cred-badge connected" title={conn.detail || ''}>
          ● connected
        </span>
      );
    }
    if (conn?.status === 'failed') {
      return (
        <span className="cc-cred-badge failed" title={conn.detail || ''}>
          ✕ failed
        </span>
      );
    }
    return <span className="cc-cred-badge unconfigured">not connected</span>;
  };

  const openOpt = config?.options.find((o) => o.key === credOpen);

  return (
    <Section
      id="source"
      title="Source"
      hint="which API the workflow retrieves its source JSONs from"
      defaultOpen
      first
      right={
        (saving && <span className="cc-source-state">⟳ saving…</span>) ||
        (saved && <span className="cc-source-state">✓ saved</span>) ||
        null
      }
    >
      {error && <div className="status-line err">{error}</div>}
      {!config && !error && <p className="muted cc-loading">Loading source…</p>}
      {config && (
        <>
          <div className="cc-source-options" role="radiogroup" aria-label="Source API">
            {config.options.map((o) => (
              <label
                key={o.key}
                className={`cc-source-option${config.source === o.key ? ' selected' : ''}`}
              >
                <input
                  type="radio"
                  name={radioGroup}
                  checked={config.source === o.key}
                  onChange={() => choose(o.key)}
                />
                <span>
                  <span className="cc-source-name">
                    {o.label} {badge(o)}
                  </span>
                  <span className="cc-source-desc">{o.description}</span>
                  {/* Credentials are offered only for the SELECTED source, so
                      e.g. picking the mock leaves no credential fields around */}
                  {o.needsCredentials && config.source === o.key && (
                    <button
                      type="button"
                      className="cc-cred-link"
                      onClick={(e) => {
                        e.preventDefault(); // don't flip the radio
                        toggleCreds(o.key);
                      }}
                    >
                      {credOpen === o.key
                        ? 'hide credentials'
                        : o.connection?.configured
                          ? 'edit credentials'
                          : 'add credentials'}
                    </button>
                  )}
                </span>
              </label>
            ))}
          </div>

          {/* Only for the mock — the real sources have Test connection in
              their credentials form instead */}
          {!config.options.find((o) => o.key === config.source)?.needsCredentials && (
            <div className="cc-source-test">
              <button
                type="button"
                className="btn btn-outline"
                disabled={testing}
                onClick={testSelected}
              >
                {testing ? '⟳ Testing…' : '⚡ Test connection'}
              </button>
              {testResult && (
                <span className={`cc-source-test-result ${testResult.status}`}>
                  {testResult.status === 'connected' ? '●' : '✕'} {testResult.label}{' '}
                  {testResult.status === 'connected' ? 'connected' : 'failed'} — {testResult.detail}
                </span>
              )}
            </div>
          )}

          {openOpt && (
            <div className="cc-cred-form">
              <div className="cc-cred-head">
                <strong>{openOpt.label} credentials</strong>
                {openOpt.connection?.status === 'connected' && (
                  <span className="cc-cred-badge connected">● {openOpt.label} connected</span>
                )}
                {openOpt.connection?.status === 'failed' && (
                  <span className="cc-cred-badge failed">✕ {openOpt.connection.detail}</span>
                )}
              </div>
              {credError && <div className="status-line err">{credError}</div>}
              <div className="cc-cred-fields">
                <div className="field">
                  <label>API base URL</label>
                  <input
                    type="text"
                    placeholder="https://api.example.com"
                    value={credDraft.baseUrl}
                    onChange={(e) => setCredDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Username (optional)</label>
                  <input
                    type="text"
                    placeholder="only for APIs using basic auth"
                    value={credDraft.username}
                    onChange={(e) => setCredDraft((d) => ({ ...d, username: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>API key / password</label>
                  <input
                    type="password"
                    placeholder={
                      openOpt.connection?.hasKey
                        ? '•••••• saved — leave blank to keep'
                        : 'paste the key or password'
                    }
                    value={credDraft.apiKey}
                    onChange={(e) => setCredDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  />
                </div>
              </div>
              <div className="cc-cred-actions">
                <button
                  type="button"
                  className="btn btn-navy"
                  disabled={Boolean(credBusy)}
                  onClick={saveCreds}
                >
                  {credBusy === 'save' ? '⟳ Connecting…' : 'Save & Connect'}
                </button>
                {openOpt.connection?.configured && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={Boolean(credBusy)}
                    onClick={testCreds}
                  >
                    {credBusy === 'verify' ? '⟳ Testing…' : 'Test connection'}
                  </button>
                )}
                {openOpt.connection?.configured && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    disabled={Boolean(credBusy)}
                    onClick={removeCreds}
                  >
                    {credBusy === 'remove' ? '⟳ Removing…' : 'Remove'}
                  </button>
                )}
              </div>
              {openOpt.connection?.verifiedAt && (
                <p className="cc-cred-checked">
                  Last checked {new Date(openOpt.connection.verifiedAt).toLocaleString()} —{' '}
                  {openOpt.connection.detail}
                </p>
              )}
            </div>
          )}

          <p className="wf-note">
            The selected source decides which API the workflow&apos;s JSONs come from — Mock-Up
            NatGasHub serves the mock API&apos;s JSON, the others theirs. NatGasHub and Cortex
            need credentials: add them and the app checks the connection right away, marking
            the source connected or failed. Retrieval currently runs against the Mock-Up
            NatGasHub API; the other sources follow this setting once their APIs are wired up.
          </p>
        </>
      )}
    </Section>
  );
}

export default function ComponentsConfig() {
  return (
    <>
      <div className="wf-group-head">
        <strong>Configure Components</strong>
        <span className="muted">
          source, pipelines, shippers, rec-del pairings and locations — click a section header
          to open it or tuck it away
        </span>
      </div>

      <div className="wf-sources" style={{ marginTop: 0, borderLeftColor: 'var(--navy)' }}>
        {/* Source — which upstream API the JSONs come from */}
        <SourceConfig />

        {/* Pipelines — rows in public.pipeline_attributes */}
        <Section
          id="pipelines"
          title="Pipelines"
          hint="adding a pipeline inserts a row into the Pipeline Attribute Table"
        >
          <p className="wf-note">
            Type into the striped input row at the bottom of the grid — right above its Add
            button — and hit ＋ to add the row. Click any existing cell to edit it in place;
            press Enter (or click away) and the change saves straight to the warehouse table.
          </p>
          <ComponentTable
            tableKey="pipeline-attributes"
            viewerName="pipeline_attributes"
            addLabel="+ Add Pipeline"
          />
        </Section>

        {/* Shippers — rows in public.shipping */}
        <Section
          id="shippers"
          title="Shippers"
          hint="adding a shipper inserts a K-holder row into the Shipping Table"
        >
          <ComponentTable tableKey="shipping" viewerName="shipping" addLabel="+ Add Shipper" />
        </Section>

        {/* Locations — rows in public.location_purpose_code */}
        <Section
          id="locations"
          title="Locations"
          hint="adding a location inserts a row into the Location Purpose Code Table"
        >
          <ComponentTable
            tableKey="location-purpose-code"
            viewerName="location_purpose_code"
            addLabel="+ Add Location"
          />
        </Section>

        {/* Rec-del pairings — rows ARE the Stage 4 pairing JSON */}
        <Section
          id="rec-del"
          title="Rec-Del Pairings"
          hint="each row is one entry of the Stage 4 pairing JSON — Pipeline, DUNS, Order, Pattern, Regex"
        >
          <p className="wf-note">
            The default patterns are seeded to match the pipeline&apos;s config file. Add a
            row to append an entry.
          </p>
          <ComponentTable
            tableKey="rec-del-pairings"
            viewerName="rec_del_pairings"
            addLabel="+ Add Pairing"
          />
        </Section>
      </div>
    </>
  );
}
