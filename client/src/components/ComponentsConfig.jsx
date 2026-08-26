import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import { api } from '../api';
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

function ComponentTable({ tableKey, viewerName, addLabel, jsonPreview }) {
  const [data, setData] = useState(null); // { columns, rows }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

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

  // The rows as the pairing JSON — same keys, same order, numbers as numbers
  const json = useMemo(() => {
    if (!jsonPreview || !data) return '';
    return JSON.stringify(
      data.rows.map((r) =>
        Object.fromEntries(editableCols.map((c) => [c.name, numify(c, r[c.name])]))
      ),
      null,
      2
    );
  }, [jsonPreview, data, editableCols]);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the JSON is still selectable below
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
            {jsonPreview && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setShowJson((s) => !s)}
              >
                {showJson ? 'Hide JSON' : '{ } View JSON'}
              </button>
            )}
            {viewerName && (
              <Link className="cc-viewer-link" to={`/tables/${viewerName}`}>
                open in Table Viewer →
              </Link>
            )}
          </div>
          {jsonPreview && showJson && (
            <div className="cc-json">
              <div className="cc-json-head">
                <span>
                  Exactly what the pairing config file looks like with these rows in it.
                </span>
                <button type="button" className="btn btn-outline dl-btn" onClick={copyJson}>
                  {copied ? '✓ Copied' : '⧉ Copy JSON'}
                </button>
              </div>
              <pre>{json}</pre>
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function ComponentsConfig() {
  return (
    <>
      <div className="wf-group-head">
        <strong>Configure Components</strong>
        <span className="muted">
          pipelines, shippers, rec-del pairings and locations — each one lives in a warehouse
          table you can add to right here
        </span>
      </div>

      <div className="wf-sources" style={{ marginTop: 0, borderLeftColor: 'var(--navy)' }}>
        <p className="wf-note">
          Type into the striped input row at the bottom of a grid — right above its Add button
          — and hit ＋ to add the row. Click any existing cell to edit it in place; press
          Enter (or click away) and the change saves straight to the warehouse table.
        </p>

        {/* Pipelines — rows in public.pipeline_attributes */}
        <div className="wf-sources-head">
          <strong>Pipelines</strong>
          <span className="muted">
            adding a pipeline inserts a row into the Pipeline Attribute Table
          </span>
        </div>
        <ComponentTable
          tableKey="pipeline-attributes"
          viewerName="pipeline_attributes"
          addLabel="+ Add Pipeline"
        />

        {/* Shippers — rows in public.shipping */}
        <div className="cc-section">
          <div className="wf-sources-head">
            <strong>Shippers</strong>
            <span className="muted">
              adding a shipper inserts a K-holder row into the Shipping Table
            </span>
          </div>
          <ComponentTable tableKey="shipping" viewerName="shipping" addLabel="+ Add Shipper" />
        </div>

        {/* Rec-del pairings — rows ARE the Stage 4 pairing JSON */}
        <div className="cc-section">
          <div className="wf-sources-head">
            <strong>Rec-Del Pairings</strong>
            <span className="muted">
              each row is one entry of the Stage 4 pairing JSON — Pipeline, DUNS, Order,
              Pattern, Regex
            </span>
          </div>
          <p className="wf-note">
            The default patterns are seeded to match the pipeline&apos;s config file. Add a row
            to append an entry; use <strong>View JSON</strong> to see (and copy) the exact
            JSON the table currently represents.
          </p>
          <ComponentTable
            tableKey="rec-del-pairings"
            viewerName="rec_del_pairings"
            addLabel="+ Add Pairing"
            jsonPreview
          />
        </div>

        {/* Locations — intentionally blank for now */}
        <div className="cc-section">
          <div className="wf-sources-head">
            <strong>Locations</strong>
            <span className="muted">add locations for this workflow — coming soon</span>
          </div>
          <p className="muted cc-placeholder">Nothing to configure here yet.</p>
        </div>
      </div>
    </>
  );
}
