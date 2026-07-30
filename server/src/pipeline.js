import { randomUUID } from 'node:crypto';
import { sql, hasDb } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local mode (no DATABASE_URL): the pipeline is simulated in memory so
// workflows still run end to end. stageCounts[0] = source record count,
// stageCounts[n] = output count of stage n.
let localBatch = null; // { batchId, stageCounts }

const COMMODITIES = ['Natural Gas', 'crude oil', 'Power', 'LNG', 'coal', 'Ethanol'];
const COUNTERPARTIES = ['Shell Trading', 'BP Energy', 'Vitol', 'Mercuria', 'Glencore', 'Trafigura'];
const REGIONS = {
  'Shell Trading': 'North America',
  'BP Energy': 'Europe',
  Vitol: 'Europe',
  Mercuria: 'Asia Pacific',
  Glencore: 'Europe',
  Trafigura: 'Asia Pacific',
};

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// NGH API pipelines a workflow can retrieve from
export const SOURCES = {
  firm: 'NGH-gTran-Firms-API-Pipeline',
  interruptible: 'NGH-gTran-Interruptibles-API-Pipeline',
  awards: 'NGH-gExchange-Awards-API-Pipeline',
  index: 'NGH-IndexOfCustomers-API-Pipeline',
};

/**
 * Dummy "retrieve from source system": generates a batch of raw trade JSON
 * for one source pipeline. Called once per selected source; passing the same
 * batchId appends to that batch. No source given = retrieve all of them.
 */
export async function retrieveSource(source, batchId) {
  const sources = source ? [source] : Object.keys(SOURCES);
  for (const s of sources) {
    if (!SOURCES[s]) throw new Error(`Unknown source "${s}".`);
  }
  const resolvedBatch = batchId || randomUUID().slice(0, 8);
  let total = 0;

  for (const s of sources) {
    const count = 8 + Math.floor(Math.random() * 13); // 8-20 records per source
    total += count;

    if (!hasDb) {
      await sleep(400 + Math.random() * 400);
      if (localBatch?.batchId === resolvedBatch) {
        localBatch.stageCounts = { 0: localBatch.stageCounts[0] + count };
      } else {
        localBatch = { batchId: resolvedBatch, stageCounts: { 0: count } };
      }
      continue;
    }

    const records = Array.from({ length: count }, (_, i) => ({
      trade_id: `TRD-${resolvedBatch}-${s.toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
      source: SOURCES[s],
      commodity: rand(COMMODITIES),
      counterparty: rand(COUNTERPARTIES),
      volume: Math.random() < 0.1 ? -1 : Math.round(Math.random() * 9500 + 500), // ~10% invalid
      price: +(Math.random() * 95 + 5).toFixed(4),
      currency: Math.random() < 0.15 ? 'usd' : 'USD',
      trade_date: new Date(Date.now() - Math.floor(Math.random() * 30) * 86400000)
        .toISOString()
        .slice(0, 10),
    }));

    await sql`INSERT INTO source_data (batch_id, payload) VALUES (${resolvedBatch}, ${JSON.stringify(records)})`;
  }

  return { batchId: resolvedBatch, source, recordCount: total };
}

async function latestBatchId() {
  const rows = await sql`SELECT batch_id FROM source_data ORDER BY retrieved_at DESC LIMIT 1`;
  if (!rows.length) throw new Error('No source data yet — click "Retrieve Source" first.');
  return rows[0].batch_id;
}

async function readStage(table, batchId) {
  const rows = await sql.query(
    `SELECT record FROM ${table} WHERE batch_id = $1 ORDER BY id`,
    [batchId]
  );
  if (!rows.length) throw new Error(`No data in ${table} for batch ${batchId} — run the previous stage first.`);
  return rows.map((r) => r.record);
}

async function writeStage(table, batchId, records) {
  await sql.query(`DELETE FROM ${table} WHERE batch_id = $1`, [batchId]);
  for (const record of records) {
    await sql.query(
      `INSERT INTO ${table} (batch_id, record) VALUES ($1, $2)`,
      [batchId, JSON.stringify(record)]
    );
  }
}

/** Stage 1 — Validation: drop records with bad volume/price, flag as validated. */
async function stage1(batchId) {
  const rows = await sql`SELECT payload FROM source_data WHERE batch_id = ${batchId} ORDER BY id`;
  if (!rows.length) throw new Error(`No source data for batch ${batchId}.`);
  const raw = rows.flatMap((r) => r.payload);
  const valid = raw.filter((r) => r.volume > 0 && r.price > 0);
  const records = valid.map((r) => ({ ...r, validated: true }));
  await writeStage('stage1_validated', batchId, records);
  return { in: raw.length, out: records.length, dropped: raw.length - records.length };
}

/** Stage 2 — Normalization: standardize casing, round prices. */
async function stage2(batchId) {
  const input = await readStage('stage1_validated', batchId);
  const records = input.map((r) => ({
    ...r,
    commodity: r.commodity.replace(/\b\w/g, (c) => c.toUpperCase()),
    currency: r.currency.toUpperCase(),
    price: +Number(r.price).toFixed(2),
  }));
  await writeStage('stage2_normalized', batchId, records);
  return { in: input.length, out: records.length };
}

/** Stage 3 — Enrichment: add notional value and counterparty region. */
async function stage3(batchId) {
  const input = await readStage('stage2_normalized', batchId);
  const records = input.map((r) => ({
    ...r,
    notional: +(r.volume * r.price).toFixed(2),
    region: REGIONS[r.counterparty] || 'Unknown',
  }));
  await writeStage('stage3_enriched', batchId, records);
  return { in: input.length, out: records.length };
}

/** Stage 4 — Aggregation: roll up positions by commodity. */
async function stage4(batchId) {
  const input = await readStage('stage3_enriched', batchId);
  const byCommodity = {};
  for (const r of input) {
    const agg = (byCommodity[r.commodity] ||= {
      commodity: r.commodity,
      trade_count: 0,
      total_volume: 0,
      total_notional: 0,
    });
    agg.trade_count += 1;
    agg.total_volume += r.volume;
    agg.total_notional = +(agg.total_notional + r.notional).toFixed(2);
  }
  const records = Object.values(byCommodity).map((a) => ({
    ...a,
    avg_price: +(a.total_notional / a.total_volume).toFixed(2),
  }));
  await writeStage('stage4_aggregated', batchId, records);
  return { in: input.length, out: records.length };
}

/** Stage 5 — Publish: final snapshot summary. */
async function stage5(batchId) {
  const input = await readStage('stage4_aggregated', batchId);
  const record = {
    batch_id: batchId,
    published_at: new Date().toISOString(),
    commodities: input.length,
    total_trades: input.reduce((s, a) => s + a.trade_count, 0),
    total_notional: +input.reduce((s, a) => s + a.total_notional, 0).toFixed(2),
    breakdown: input,
  };
  await writeStage('stage5_published', batchId, [record]);
  return { in: input.length, out: 1 };
}

export const STAGES = { 1: stage1, 2: stage2, 3: stage3, 4: stage4, 5: stage5 };

export async function runStage(n, batchId) {
  const fn = STAGES[n];
  if (!fn) throw new Error(`Unknown stage ${n}`);
  if (!hasDb) return simulateStage(n, batchId);
  const resolved = batchId || (await latestBatchId());
  const result = await fn(resolved);
  return { stage: n, batchId: resolved, ...result };
}

/** Local-mode stand-in for a stage: plausible in/out counts, no database. */
async function simulateStage(n, batchId) {
  await sleep(500 + Math.random() * 600);
  if (!localBatch) throw new Error('No source data yet — run Retrieve Source first.');
  const resolved = batchId || localBatch.batchId;
  const input = localBatch.stageCounts[n - 1];
  if (input === undefined) {
    throw new Error(`No data for stage ${n} — run the previous stage first.`);
  }
  let out;
  if (n === 1) out = Math.max(1, Math.round(input * 0.9)); // validation drops ~10%
  else if (n === 4) out = Math.min(input, 4 + Math.floor(Math.random() * 3)); // aggregate by commodity
  else if (n === 5) out = 1; // single published snapshot
  else out = input;
  localBatch.stageCounts[n] = out;
  const result = { stage: n, batchId: resolved, in: input, out };
  if (n === 1) result.dropped = input - out;
  return result;
}

/** Runs the whole pipeline: retrieve source, then stages 1-5. Logs each step. */
export async function runFullPipeline(workflowId) {
  const [run] = await sql`
    INSERT INTO workflow_runs (workflow_id, status) VALUES (${workflowId}, 'running') RETURNING id`;
  const log = [];
  const step = async (name, fn) => {
    const started = Date.now();
    const result = await fn();
    log.push({ step: name, ms: Date.now() - started, result });
    await sql`UPDATE workflow_runs SET log = ${JSON.stringify(log)} WHERE id = ${run.id}`;
    return result;
  };

  try {
    const { batchId } = await step('retrieve_source', retrieveSource);
    await sql`UPDATE workflow_runs SET batch_id = ${batchId} WHERE id = ${run.id}`;
    for (const n of [1, 2, 3, 4, 5]) {
      await step(`stage_${n}`, () => runStage(n, batchId));
    }
    await sql`
      UPDATE workflow_runs SET status = 'success', finished_at = now() WHERE id = ${run.id}`;
    await sql`UPDATE workflows SET last_run_at = now() WHERE id = ${workflowId}`;
    return { runId: run.id, batchId, status: 'success', log };
  } catch (err) {
    log.push({ step: 'error', message: err.message });
    await sql`
      UPDATE workflow_runs SET status = 'failed', finished_at = now(), log = ${JSON.stringify(log)}
      WHERE id = ${run.id}`;
    return { runId: run.id, status: 'failed', error: err.message, log };
  }
}
