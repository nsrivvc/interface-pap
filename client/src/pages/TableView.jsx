import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import { api, apiDownload } from '../api';
import Header from '../components/Header';
import { gridTheme } from '../grid-theme';
import { buildGoldReport, describeFilterModel } from '../gold-report';
import { pbiService, goldDatasetPayload, createReportConfig, editReportConfig, ensureStarterReport } from '../powerbi';

const DOWNLOAD_FORMATS = ['csv', 'xlsx', 'parquet'];

function formatCell(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return new Date(str).toLocaleString();
  return str;
}

export default function TableView() {
  const { name } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [quickFilter, setQuickFilter] = useState('');
  const [downloading, setDownloading] = useState(null); // format while a download runs
  const [downloadError, setDownloadError] = useState('');
  const gridApiRef = useRef(null);
  const [gold, setGold] = useState(null); // { url, rowCount, at } once generated

  // Build the gold-layer report from the grid's CURRENT filtered + sorted view
  const generateGold = () => {
    const gridApi = gridApiRef.current;
    if (!gridApi || !data) return;
    const rows = [];
    gridApi.forEachNodeAfterFilterAndSort((node) => rows.push(node.data));
    const html = buildGoldReport({
      name,
      label: data.label,
      rows,
      totalCount: data.rows.length,
      filters: describeFilterModel(gridApi.getFilterModel(), quickFilter),
    });
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    setGold({ url, rowCount: rows.length, at: new Date() });
  };

  // Revoke the previous report's blob URL when regenerated / table changed
  useEffect(() => () => { if (gold?.url) URL.revokeObjectURL(gold.url); }, [gold]);

  const downloadViewCsv = () =>
    gridApiRef.current?.exportDataAsCsv({ fileName: `${name}_gold_view.csv` });

  // Power BI quick-create: push the filtered rows into an editable report
  // canvas. 'boot' first renders the container div, then the effect embeds.
  const pbiRef = useRef(null);
  const pbiRebooted = useRef(false); // guards the one-time create->edit restart
  const [pbi, setPbi] = useState(null); // null | 'boot' | 'authoring' | 'ready' | { error }

  useEffect(() => {
    if (pbi !== 'boot' || !pbiRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const gridApi = gridApiRef.current;
        const rows = [];
        gridApi.forEachNodeAfterFilterAndSort((node) => rows.push(node.data));
        if (!rows.length) throw new Error('No rows in the current view.');
        const modelName = `PAP · ${data?.label || name}`;
        const payload = goldDatasetPayload(rows);
        const post = () =>
          api('/api/powerbi/gold-report', { method: 'POST', body: { modelName, ...payload } });
        let embed;
        try {
          embed = await post();
        } catch (err) {
          // A bare 5xx/network error usually means the dev API was mid-restart
          // (node --watch) — retry once before surfacing it.
          const transient = /^Request failed \(5|failed to fetch|networkerror/i.test(err.message);
          if (!transient) throw err;
          await new Promise((resolve) => setTimeout(resolve, 2500));
          embed = await post();
        }
        if (cancelled) return;
        pbiService.reset(pbiRef.current);
        if (embed.mode === 'edit') {
          // Open the saved report over the fresh rows; if it's empty (first
          // generate, or the user deleted everything) build the starter
          // visuals right here and save them into it.
          const report = pbiService.embed(pbiRef.current, editReportConfig(embed));
          report.on('error', (event) =>
            setPbi({ error: event?.detail?.message || 'Power BI reported an error.' })
          );
          report.on('loaded', async () => {
            try {
              setPbi('authoring');
              const { authored, skipped } = await ensureStarterReport(report, payload.columns, rows);
              if (authored && skipped.length) console.warn('starter visuals skipped:', skipped);
              setPbi('ready');
            } catch (err) {
              console.warn('auto-author failed:', err);
              setPbi('ready'); // canvas still usable by hand
            }
          });
        } else {
          // No saved report yet: boot the create canvas just long enough to
          // save an empty report into the workspace, then restart into the
          // edit path above, which authors the starter visuals.
          const created = pbiService.createReport(pbiRef.current, createReportConfig(embed));
          created.on('error', (event) =>
            setPbi({ error: event?.detail?.message || 'Power BI reported an error.' })
          );
          created.on('loaded', async () => {
            try {
              await created.saveAs({ name: modelName });
            } catch (err) {
              setPbi({ error: `Could not save the new report: ${err?.message || err}` });
            }
          });
          created.on('saved', () => {
            if (!pbiRebooted.current) {
              pbiRebooted.current = true;
              setPbi('boot'); // server will now find the report -> edit path
            }
          });
        }
      } catch (err) {
        if (!cancelled) setPbi({ error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [pbi, name, data]);

  const download = async (format) => {
    setDownloading(format);
    setDownloadError('');
    try {
      await apiDownload(`/api/tables/${name}/download?format=${format}`);
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(null);
    }
  };

  useEffect(() => {
    setData(null);
    setError('');
    setQuickFilter('');
    setGold(null);
    setPbi(null);
    api(`/api/tables/${name}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [name]);

  const columnDefs = useMemo(() => {
    if (!data?.rows?.length) return [];
    return Object.keys(data.rows[0]).map((field) => ({
      field,
      headerName: field,
      valueFormatter: (p) => formatCell(p.value),
      filter: true,
      sortable: true,
      resizable: true,
      // JSON payload columns get more room
      flex: typeof data.rows[0][field] === 'object' && data.rows[0][field] !== null ? 2 : 1,
      minWidth: 130,
      tooltipValueGetter: (p) =>
        typeof p.value === 'object' && p.value !== null ? JSON.stringify(p.value, null, 2) : undefined,
    }));
  }, [data]);

  return (
    <>
      <Header />
      <div className="page">
        <Link to="/tables" className="back-link">
          ← Back to Table Viewer
        </Link>
        <div className="tableview-head">
          <h2>{data?.label || name}</h2>
          <div className="tableview-actions">
            {data && (
              <div className="dl-group">
                <span className="dl-label">Download</span>
                {DOWNLOAD_FORMATS.map((format) => (
                  <button
                    key={format}
                    className="btn btn-outline dl-btn"
                    disabled={downloading !== null}
                    onClick={() => download(format)}
                    title={
                      format === 'parquet'
                        ? 'Latest Parquet file exported by the pipeline'
                        : `Download all rows as ${format.toUpperCase()}`
                    }
                  >
                    {downloading === format ? <span className="spin">⟳</span> : '↓'}{' '}
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            {data?.rows?.length > 0 && (
              <input
                type="text"
                className="grid-search"
                placeholder="Search all columns…"
                value={quickFilter}
                onChange={(e) => setQuickFilter(e.target.value)}
              />
            )}
          </div>
        </div>
        {error && <div className="status-line err">{error}</div>}
        {downloadError && <div className="status-line err">{downloadError}</div>}
        {!data && !error && <p>Loading…</p>}
        {data && data.rows.length === 0 && (
          <div className="card">
            <p className="muted">
              No rows yet — run a workflow from the dashboard to populate this table.
            </p>
          </div>
        )}
        {data && data.rows.length > 0 && (
          <>
            <p className="muted" style={{ margin: '10px 0 12px', color: 'var(--slate)', fontSize: '0.85rem' }}>
              Showing the {data.rows.length} most recent rows — click a header to sort, use the
              menu on each column to filter.
            </p>
            <div style={{ height: 560 }}>
              <AgGridReact
                theme={gridTheme}
                rowData={data.rows}
                columnDefs={columnDefs}
                quickFilterText={quickFilter}
                pagination
                paginationPageSize={25}
                paginationPageSizeSelector={[25, 50, 100, 200]}
                enableCellTextSelection
                tooltipShowDelay={300}
                onGridReady={(e) => { gridApiRef.current = e.api; }}
              />
            </div>

            {/* Gold layer: snapshot the current filtered view as a report */}
            <div style={{ marginTop: 22, paddingBottom: 30 }}>
              <button
                className="btn"
                onClick={generateGold}
                style={{
                  background: 'linear-gradient(120deg, #c99a2e, #e0b545)',
                  border: 'none',
                  color: '#1f2a44',
                  fontWeight: 600,
                }}
              >
                ✨ Generate Gold Layer Table
              </button>
              <button
                className="btn"
                onClick={() => { pbiRebooted.current = false; setPbi('boot'); }}
                disabled={pbi === 'boot' || pbi === 'authoring'}
                style={{
                  marginLeft: 10,
                  background: 'linear-gradient(120deg, #f2c811, #e8b30a)',
                  border: 'none',
                  color: '#1f2a44',
                  fontWeight: 600,
                }}
              >
                {pbi === 'boot' ? '⟳ Creating…' : pbi === 'authoring' ? '⟳ Building visuals…' : '⚡ Generate Power BI Report'}
              </button>
              <span className="muted" style={{ marginLeft: 12, fontSize: '0.83rem', color: 'var(--slate)' }}>
                Both use the rows currently matching your filters — gold layer is an instant
                snapshot; Power BI opens a live editing canvas.
              </span>

              {pbi?.error && (
                <div className="status-line err" style={{ marginTop: 12 }}>
                  Power BI: {pbi.error}
                </div>
              )}
              {(pbi === 'boot' || pbi === 'authoring' || pbi === 'ready') && (
                <div className="card" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
                      borderBottom: '1px solid #e6e8ef',
                    }}
                  >
                    <strong style={{ fontSize: '0.95rem' }}>Power BI Report</strong>
                    <span className="muted" style={{ fontSize: '0.82rem', color: 'var(--slate)' }}>
                      {pbi === 'boot'
                        ? 'Pushing data to Power BI and generating the report…'
                        : pbi === 'authoring'
                          ? 'Auto-building starter visuals from the table schema…'
                          : 'Live report over the rows currently matching your filters — edit freely; Save keeps changes in the PAP Analytics workspace.'}
                    </span>
                  </div>
                  <div ref={pbiRef} style={{ width: '100%', height: 680 }} />
                </div>
              )}

              {gold && (
                <div className="card" style={{ marginTop: 16, padding: 0, overflow: 'hidden' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 16px',
                      borderBottom: '1px solid #e6e8ef',
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong style={{ fontSize: '0.95rem' }}>Gold Layer Report</strong>
                    <span className="muted" style={{ fontSize: '0.82rem', color: 'var(--slate)' }}>
                      {gold.rowCount} rows · generated {gold.at.toLocaleTimeString()}
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <a
                        className="btn btn-outline dl-btn"
                        href={gold.url}
                        download={`${name}_gold_report.html`}
                        style={{ textDecoration: 'none' }}
                      >
                        ↓ Report (HTML)
                      </a>
                      <button className="btn btn-outline dl-btn" onClick={downloadViewCsv}>
                        ↓ View Data (CSV)
                      </button>
                    </span>
                  </div>
                  <iframe
                    src={gold.url}
                    title="Gold layer report"
                    style={{ width: '100%', height: 620, border: 0, display: 'block' }}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
