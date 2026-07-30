import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import Header from '../components/Header';

export default function TableView() {
  const { name } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    setError('');
    api(`/api/tables/${name}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [name]);

  const columns = data?.rows?.length ? Object.keys(data.rows[0]) : [];

  return (
    <>
      <Header />
      <div className="page">
        <Link to="/" className="back-link">
          ← Back to Dashboard
        </Link>
        <h2 style={{ marginBottom: 18 }}>{data?.label || name}</h2>
        {error && <div className="status-line err">{error}</div>}
        {!data && !error && <p>Loading…</p>}
        {data && data.rows.length === 0 && (
          <div className="card">
            <p className="muted">
              No rows yet — run the pipeline from the dashboard to populate this table.
            </p>
          </div>
        )}
        {data && data.rows.length > 0 && (
          <>
            <p className="muted" style={{ marginBottom: 12, color: 'var(--slate)', fontSize: '0.85rem' }}>
              Showing {data.rows.length} most recent rows
            </p>
            <div className="data-table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr key={i}>
                      {columns.map((c) => (
                        <Cell key={c} value={row[c]} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Cell({ value }) {
  if (value === null || value === undefined) return <td className="muted">—</td>;
  if (typeof value === 'object') {
    return <td className="json-cell">{JSON.stringify(value, null, 1)}</td>;
  }
  const str = String(value);
  // Render timestamps readably
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    return <td>{new Date(str).toLocaleString()}</td>;
  }
  return <td>{str}</td>;
}
