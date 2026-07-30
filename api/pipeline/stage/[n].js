import { requireAuth, sleep, seedFrom } from '../../_lib.js';

// Stateless stage simulation: record counts are derived from the batch id so
// consecutive serverless invocations stay consistent without shared memory.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;

  const n = Number(req.query.n);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return res.status(400).json({ error: `Unknown stage ${req.query.n}` });
  }
  const { batchId } = req.body || {};
  if (!batchId) {
    return res.status(400).json({ error: 'No source data yet — run Retrieve Source first.' });
  }

  await sleep(500 + Math.random() * 600);

  // Walk the chain from the seeded source count down to stage n
  const seed = seedFrom(batchId);
  let count = 30 + (seed % 50); // total records retrieved for this batch
  let input = count;
  for (let stage = 1; stage <= n; stage++) {
    input = count;
    if (stage === 1) count = Math.max(1, Math.round(count * 0.9)); // validation drops ~10%
    else if (stage === 4) count = Math.min(count, 4 + (seed % 3)); // aggregate by commodity
    else if (stage === 5) count = 1; // single published snapshot
  }

  const result = { stage: n, batchId, in: input, out: count };
  if (n === 1) result.dropped = input - count;
  res.json(result);
}
