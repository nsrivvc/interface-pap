// Table downloads: CSV and XLSX are generated from the backing Postgres
// table; Parquet is served from the pipeline repos' export directories.
//
// Parquet layouts (see each repo's parquet_export.py):
//   Stage 2:    <stage2 dir>/<feed_type>/<table>/ingest_date=YYYY-MM-DD/<run_id>.parquet
//   Stage 3-5:  <stage345 dir>/<stage>/<source>/<table>/run_date=YYYY-MM-DD/<run_id>.parquet
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { sql } from './db.js';
import { requireAuth } from './auth.js';

// repo_root/server/src -> the Codebases directory that also holds pipeline-codebases
const CODEBASES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const STAGE2_PARQUET_DIR =
  process.env.PARQUET_STAGE2_DIR ||
  path.join(CODEBASES_DIR, 'pipeline-codebases', 'json--bronze--postgres', 'parquet_output');

const STAGE345_PARQUET_DIR =
  process.env.PARQUET_STAGE345_DIR ||
  path.join(CODEBASES_DIR, 'pipeline-codebases', 'bronze_to_silver_conversion', 'parquet_output');

// ---------- table name -> parquet search spec ----------

// "firm_locations_standardized" -> { stage: 3, source: 'firm', kind: 'locations' }
function classify(name) {
  let stage = null;
  // The raw_* tables are Stage 2's cards in the UI, so they map to the
  // Bronze parquet exports.
  if (name.startsWith('raw_') || name.startsWith('bronze_')) stage = 2;
  else if (name.endsWith('_standardized_transformed')) stage = 4;
  else if (name.endsWith('_standardized')) stage = 3;
  else if (name.endsWith('_master_capacity')) stage = 5;
  if (stage === null) return null; // logging, exceptions — no parquet export

  const first = name.replace(/^(raw|bronze)_/, '').split('_')[0];
  const source = { firm: 'firm', interruptible: 'interruptible', awards: 'awards', index: 'ioc', final: 'final' }[first];
  if (!source) return null;

  const kind = name.includes('_locations') ? 'locations'
    : name.includes('_rates') ? 'rates'
    : name.includes('_core') ? 'core'
    : null;
  return { stage, source, kind };
}

// Does a directory name (feed or source) belong to the given canonical source?
function dirMatchesSource(dir, source) {
  const d = dir.toLowerCase();
  switch (source) {
    case 'firm': return d.includes('firm');
    case 'interruptible': return d.includes('interrupt') || /(^|_)it(_|$)/.test(d);
    case 'awards': return d.includes('award');
    case 'ioc': return d.includes('ioc') || d.includes('index') || d.includes('customer');
    case 'final': return d === '_combined';
    default: return false;
  }
}

// A table directory's "kind" from its name; core = neither locations nor rates.
function dirMatchesKind(dir, kind) {
  if (!kind) return true;
  const d = dir.toLowerCase();
  const isLoc = d.includes('loc');
  const isRates = d.includes('rate');
  if (kind === 'locations') return isLoc;
  if (kind === 'rates') return isRates;
  return !isLoc && !isRates; // core
}

async function walkParquet(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkParquet(p)));
    else if (e.isFile() && e.name.endsWith('.parquet')) {
      out.push({ path: p, mtime: (await fs.stat(p)).mtimeMs });
    }
  }
  return out;
}

/** Newest parquet file matching the table's stage/source/kind, or null. */
async function findParquet(spec) {
  if (spec.stage === 2) {
    // <feed_type>/<table>/ingest_date=.../<file>
    const files = await walkParquet(STAGE2_PARQUET_DIR);
    const matches = files.filter((f) => {
      const [feed, table] = path.relative(STAGE2_PARQUET_DIR, f.path).split(path.sep);
      return feed && table && dirMatchesSource(feed, spec.source) && dirMatchesKind(table, spec.kind);
    });
    return matches.sort((a, b) => b.mtime - a.mtime)[0] || null;
  }

  // <stage>/<source>/<table>/run_date=.../<file> — prefer the exact stage
  // directory, fall back to "unstaged" (runs exported without PARQUET_STAGE).
  const stageDirs = { exact: [`stage${spec.stage}`, `stage_${spec.stage}`], fallback: ['unstaged'] };
  const files = await walkParquet(STAGE345_PARQUET_DIR);
  const matches = files
    .map((f) => {
      const [stage, source, table] = path.relative(STAGE345_PARQUET_DIR, f.path).split(path.sep);
      if (!stage || !source || !table) return null;
      const rank = stageDirs.exact.includes(stage.toLowerCase()) ? 0
        : stageDirs.fallback.includes(stage.toLowerCase()) ? 1
        : -1;
      if (rank === -1) return null;
      if (!(source.toLowerCase() === spec.source || dirMatchesSource(source, spec.source))) return null;
      if (!dirMatchesKind(table, spec.kind)) return null;
      return { ...f, rank };
    })
    .filter(Boolean);
  return matches.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)[0] || null;
}

// ---------- CSV / XLSX ----------

const cellValue = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

function toCSV(rows) {
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(cellValue(v));
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [
    cols.join(','),
    ...rows.map((r) => cols.map((c) => esc(r[c])).join(',')),
  ].join('\r\n');
}

function toXLSX(rows) {
  const flat = rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cellValue(v)]))
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------- route ----------

export function registerDownloadRoute(app, tableIndex) {
  app.get('/api/tables/:name/download', requireAuth, async (req, res) => {
    try {
      const table = tableIndex[req.params.name];
      if (!table) return res.status(404).json({ error: 'Unknown table.' });
      const format = String(req.query.format || 'csv').toLowerCase();

      if (format === 'parquet') {
        const spec = classify(table.name);
        if (!spec) {
          return res.status(404).json({
            error: 'No Parquet export exists for this table — only Stage 2-5 pipeline tables are exported to Parquet.',
          });
        }
        const file = await findParquet(spec);
        if (!file) {
          return res.status(404).json({
            error: `No Parquet file found yet for ${table.name} (stage ${spec.stage}, ${spec.source}${spec.kind ? `/${spec.kind}` : ''}). Run the stage ${spec.stage} pipeline to produce one.`,
          });
        }
        return res.download(file.path, `${table.name}__${path.basename(file.path)}`);
      }

      // raw_payload duplicates every business column as a large JSON blob;
      // leaving it out keeps spreadsheet exports small and fast. The Parquet
      // download is the faithful copy that includes it.
      let rows = [];
      try {
        const [schema, name] = table.backing.includes('.')
          ? table.backing.split('.')
          : ['public', table.backing];
        const cols = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = ${name}
          ORDER BY ordinal_position`;
        const selected = cols
          .map((c) => c.column_name)
          .filter((c) => c !== 'raw_payload')
          .map((c) => `"${c}"`)
          .join(', ');
        rows = await sql.query(
          `SELECT ${selected || '*'} FROM ${table.backing} ORDER BY ${table.orderBy || 'id'} DESC`
        );
      } catch {
        rows = [];
      }
      if (!rows.length) {
        return res.status(404).json({ error: 'Table is empty — nothing to download yet.' });
      }

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${table.name}.csv"`);
        return res.send(toCSV(rows));
      }
      if (format === 'xlsx') {
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="${table.name}.xlsx"`);
        return res.send(toXLSX(rows));
      }
      res.status(400).json({ error: `Unknown format "${format}" — use csv, xlsx or parquet.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
