// Builds the self-contained "Gold Layer" report HTML for a table view.
//
// This is the native stand-in for a Power BI filtered view: the user filters a
// table with the grid's column filters / search, then generates a report of
// exactly that slice. Once a real Power BI report is embedded with a token,
// the same UX can be driven through powerbi-client's report.updateFilters().

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmt(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return new Date(str).toLocaleString();
  return str;
}

// One grid filter condition -> readable text, e.g. `contains "ANR"`.
const cond = (c) => {
  const val = c.filter ?? c.dateFrom ?? '';
  const to = c.filterTo ?? c.dateTo;
  return to !== undefined && to !== null ? `${c.type} ${val}–${to}` : `${c.type} "${val}"`;
};

// AG Grid filter model + quick-search text -> ["search \"x\"", "col contains \"y\""]
export function describeFilterModel(model, quick) {
  const parts = Object.entries(model || {}).map(([field, m]) =>
    m.conditions
      ? `${field} ${m.conditions.map(cond).join(` ${(m.operator || 'and').toLowerCase()} `)}`
      : `${field} ${cond(m)}`
  );
  if (quick) parts.unshift(`search "${quick}"`);
  return parts;
}

const isNum = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v));

export function buildGoldReport({ name, label, rows, totalCount, filters }) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const at = new Date();

  // KPI cards: row/column counts plus sum & avg of up to three numeric columns
  const numericCols = columns
    .filter((c) => rows.some((r) => isNum(r[c])) && !/(^|_)id$/i.test(c))
    .slice(0, 3);
  const kpis = [
    { label: 'Rows in view', value: rows.length.toLocaleString() },
    { label: 'Of total rows', value: totalCount.toLocaleString() },
    { label: 'Columns', value: String(columns.length) },
    ...numericCols.map((c) => {
      const vals = rows.map((r) => r[c]).filter(isNum).map(Number);
      const sum = vals.reduce((a, b) => a + b, 0);
      return {
        label: `Σ ${c}`,
        value: sum.toLocaleString(undefined, { maximumFractionDigits: 2 }),
        sub: `avg ${(sum / (vals.length || 1)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      };
    }),
  ];

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(label || name)} — Gold Layer</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f4f5f8; color: #1f2a44; }
  .band { background: linear-gradient(120deg, #1f2a44 55%, #3a4a74); color: #fff; padding: 26px 32px; border-bottom: 4px solid #c99a2e; }
  .band .eyebrow { color: #e9c46a; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; }
  .band h1 { font-size: 22px; margin-top: 4px; font-weight: 600; }
  .band .meta { margin-top: 6px; font-size: 12px; color: #c7cede; }
  .filters { padding: 12px 32px 0; font-size: 12.5px; color: #5b6478; }
  .filters span { display: inline-block; background: #fff; border: 1px solid #e2d9be; border-left: 3px solid #c99a2e; border-radius: 6px; padding: 4px 10px; margin: 0 6px 6px 0; }
  .kpis { display: flex; flex-wrap: wrap; gap: 14px; padding: 18px 32px; }
  .kpi { background: #fff; border-radius: 10px; padding: 14px 20px; min-width: 150px; box-shadow: 0 1px 4px rgba(31,42,68,.09); border-top: 3px solid #c99a2e; }
  .kpi .v { font-size: 22px; font-weight: 600; }
  .kpi .l { font-size: 11.5px; color: #5b6478; text-transform: uppercase; letter-spacing: .6px; margin-top: 3px; }
  .kpi .s { font-size: 11.5px; color: #8b93a7; margin-top: 2px; }
  .wrap { margin: 4px 32px 32px; background: #fff; border-radius: 10px; box-shadow: 0 1px 4px rgba(31,42,68,.09); overflow: auto; max-height: 70vh; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { position: sticky; top: 0; background: #1f2a44; color: #fff; text-align: left; padding: 9px 12px; font-weight: 600; white-space: nowrap; }
  td { padding: 7px 12px; border-bottom: 1px solid #eef0f4; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
  tr:nth-child(even) td { background: #f9fafc; }
  .foot { padding: 0 32px 26px; font-size: 11.5px; color: #8b93a7; }
</style></head><body>
<div class="band">
  <div class="eyebrow">Gold Layer Report</div>
  <h1>${esc(label || name)}</h1>
  <div class="meta">Source table: ${esc(name)} · Generated ${esc(at.toLocaleString())}</div>
</div>
${
  filters.length
    ? `<div class="filters">Filters applied: ${filters.map((f) => `<span>${esc(f)}</span>`).join('')}</div>`
    : `<div class="filters"><span>No filters — full table view</span></div>`
}
<div class="kpis">${kpis
    .map(
      (k) =>
        `<div class="kpi"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div>${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ''}</div>`
    )
    .join('')}</div>
<div class="wrap"><table>
  <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>${rows
    .map((r) => `<tr>${columns.map((c) => `<td>${esc(fmt(r[c]))}</td>`).join('')}</tr>`)
    .join('')}</tbody>
</table></div>
<div class="foot">Generated by Pipeline Accelerator Program · ${rows.length} of ${totalCount} rows shown</div>
</body></html>`;
}
