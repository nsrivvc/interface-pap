import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule, themeQuartz } from 'ag-grid-community';
import { api, apiDownload } from '../api';
import Header from '../components/Header';

const DOWNLOAD_FORMATS = ['csv', 'xlsx', 'parquet'];

ModuleRegistry.registerModules([AllCommunityModule]);

// Match the Value Creed look
const gridTheme = themeQuartz.withParams({
  accentColor: '#c05a1e',
  headerBackgroundColor: '#1f2a44',
  headerTextColor: '#ffffff',
  fontFamily: "'Poppins', system-ui, sans-serif",
  fontSize: 13,
  headerFontWeight: 600,
  borderRadius: 8,
  wrapperBorderRadius: 12,
});

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
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
