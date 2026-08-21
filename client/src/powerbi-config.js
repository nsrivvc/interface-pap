// Pure config-building for the Power BI quick-create embed — no browser
// dependencies, so it is unit-testable in Node. See powerbi.js for the
// service that boots the canvas.
import { TokenType } from 'powerbi-models';

const NUM_RE = /^-?\d+(\.\d+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// Infer a Power BI DataType for a column from the values present.
function inferType(rows, col) {
  const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
  if (!vals.length) return 'Text';
  if (vals.every((v) => typeof v === 'boolean')) return 'Logical';
  if (vals.every((v) => typeof v === 'number' || (typeof v === 'string' && NUM_RE.test(v))))
    return 'Number';
  if (vals.every((v) => typeof v === 'string' && ISO_RE.test(v))) return 'DateTime';
  return 'Text';
}

// Push-dataset value: real JSON types (numbers as numbers, bools as bools).
function toValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'Number') return Number(value);
  if (type === 'Logical') return Boolean(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Our inferred types -> Power BI push-dataset column types
const PUSH_TYPE = { Number: 'Double', Logical: 'Bool', DateTime: 'DateTime', Text: 'String' };

/** Body for POST /api/powerbi/gold-report: schema + rows of the current view. */
export function goldDatasetPayload(rows) {
  const columns = Object.keys(rows[0]);
  const types = Object.fromEntries(columns.map((c) => [c, inferType(rows, c)]));
  return {
    columns: columns.map((c) => ({ name: c, dataType: PUSH_TYPE[types[c]] })),
    rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, toValue(r[c], types[c])]))),
  };
}

/** powerbi.createReport() configuration over the pushed dataset. */
export function createReportConfig({ embedToken, datasetId, embedUrl }) {
  return {
    type: 'create',
    datasetId,
    embedUrl,
    accessToken: embedToken,
    tokenType: TokenType.Embed,
    settings: { localeSettings: { language: 'en-US' } },
  };
}
