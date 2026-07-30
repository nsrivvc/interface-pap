export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.status(400).json({
    error: 'Registration requires the database, which is not connected yet. Sign in with admin / 12345.',
  });
}
