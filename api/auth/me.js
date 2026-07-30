import { requireAuth } from '../_lib.js';

export default function handler(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;
  res.json({ user });
}
