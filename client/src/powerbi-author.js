// Auto-authors the starter "gold layer" report on a fresh create-mode canvas:
// picks a measure, categories and a date column from the pushed schema, lays
// out card / slicer / column chart / donut / trend / table, then saves the
// report into the workspace so later generates re-embed it directly.
// Uses the powerbi-report-authoring extensions (page.createVisual /
// visual.addDataField).

const SCHEMAS = {
  column: 'http://powerbi.com/product/schema#column',
  columnAggr: 'http://powerbi.com/product/schema#columnAggr',
};

const col = (name) => ({ $schema: SCHEMAS.column, table: 'Table', column: name });
const sum = (name) => ({
  $schema: SCHEMAS.columnAggr,
  table: 'Table',
  column: name,
  aggregationFunction: 'Sum',
});

const ID_RE = /(^|_)(id|index|key)s?$|_id$/i;

// Choose the fields the starter visuals are built around.
export function pickFields(columns, rows) {
  const byType = (t) => columns.filter((c) => c.dataType === t).map((c) => c.name);
  const distinct = (name) => new Set(rows.map((r) => r[name]).filter((v) => v != null)).size;

  const measures = byType('Double').filter((n) => !ID_RE.test(n));
  const measure =
    measures.find((n) => /quantity|capacity|amount|value|volume|rate|price|total|qty/i.test(n)) ||
    measures[0] ||
    null;

  // Categoricals worth charting: 2-30 distinct values, preferred names first
  const cats = byType('String')
    .map((n) => ({ n, d: distinct(n) }))
    .filter(({ d }) => d >= 2 && d <= 30)
    .sort(
      (a, b) =>
        Number(/zone|type|purpose|code|status|category|source|segment/i.test(b.n)) -
        Number(/zone|type|purpose|code|status|category|source|segment/i.test(a.n))
    )
    .map(({ n }) => n);

  const dates = byType('DateTime');
  const date =
    dates.find((n) => /beg|start|effective/i.test(n)) ||
    dates.find((n) => /posted|update/i.test(n)) ||
    dates[0] ||
    null;

  // Table visual: leading id, cats, measure and date first, then the rest
  const lead = columns
    .map((c) => c.name)
    .filter((n) => n === measure || n === date || cats.slice(0, 3).includes(n) || ID_RE.test(n))
    .slice(0, 7);
  return { measure, cats, date, tableCols: lead.length ? lead : columns.slice(0, 6).map((c) => c.name) };
}

// Two-column grid on the default 1280x720 canvas
const L = 16, W = 616, R = 648, FULL = 1248;

export async function buildStarterReport(report, columns, rows, modelName) {
  const page = (await report.getPages())[0];
  const { measure, cats, date, tableCols } = pickFields(columns, rows);
  const errors = [];

  const add = async (type, layout, fields) => {
    try {
      const { visual } = await page.createVisual(type, layout, false);
      for (const [role, target] of fields) await visual.addDataField(role, target);
      return true;
    } catch (err) {
      errors.push(`${type}: ${err?.message || JSON.stringify(err).slice(0, 120)}`);
      return false;
    }
  };

  if (measure) {
    await add('card', { x: L, y: 16, width: W, height: 110 }, [['Values', sum(measure)]]);
  }
  if (cats[0]) {
    await add('slicer', { x: R, y: 16, width: W, height: 110 }, [['Values', col(cats[0])]]);
    if (measure)
      await add('clusteredColumnChart', { x: L, y: 142, width: W, height: 280 }, [
        ['Category', col(cats[0])],
        ['Y', sum(measure)],
      ]);
  }
  if (measure && (cats[1] || cats[0])) {
    await add('donutChart', { x: R, y: 142, width: W, height: 280 }, [
      ['Category', col(cats[1] || cats[0])],
      ['Y', sum(measure)],
    ]);
  }
  const bottomLeftUsed =
    date && measure
      ? await add('lineChart', { x: L, y: 438, width: W, height: 266 }, [
          ['Category', col(date)],
          ['Y', sum(measure)],
        ])
      : false;
  await add(
    'tableEx',
    bottomLeftUsed
      ? { x: R, y: 438, width: W, height: 266 }
      : { x: L, y: 438, width: FULL, height: 266 },
    tableCols.map((n) => ['Values', col(n)])
  );

  // Persist so the next generate embeds this report directly with fresh rows
  await report.saveAs({ name: modelName });
  return errors;
}
