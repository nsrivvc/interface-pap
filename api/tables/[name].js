import { requireAuth } from '../_lib.js';
import { STAGE_TABLES } from './index.js';

export default function handler(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  const { name } = req.query;
  const table = STAGE_TABLES.flatMap((s) => s.tables).find((t) => t.name === name);
  if (!table) return res.status(400).json({ error: 'Unknown table.' });
  res.json({ name: table.name, label: table.label, rows: [] });
}
