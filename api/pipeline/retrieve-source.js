import { randomUUID } from 'node:crypto';
import { requireAuth, sleep, SOURCES } from '../_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;

  const { source, batchId } = req.body || {};
  if (source && !SOURCES[source]) {
    return res.status(400).json({ error: `Unknown source "${source}".` });
  }
  await sleep(400 + Math.random() * 400);
  const resolvedBatch = batchId || randomUUID().slice(0, 8);
  const count = source
    ? 8 + Math.floor(Math.random() * 13)
    : Object.keys(SOURCES).length * 14;
  res.json({ batchId: resolvedBatch, source, recordCount: count });
}
