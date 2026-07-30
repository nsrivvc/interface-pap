// Shared helpers for the Vercel serverless API.
//
// This is the DEMO deployment backend: no database. It mirrors the Express
// server's "local mode" (admin login + simulated pipeline). The full
// Express + Neon implementation lives in server/ and is not deployed to
// Vercel — connect Neon there later.
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

export const LOCAL_ADMIN = { id: 0, name: 'Admin', email: 'admin' };

export const SOURCES = {
  firm: 'NGH-gTran-Firms-API-Pipeline',
  interruptible: 'NGH-gTran-Interruptibles-API-Pipeline',
  awards: 'NGH-gExchange-Awards-API-Pipeline',
  index: 'NGH-IndexOfCustomers-API-Pipeline',
};

export function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '7d',
  });
}

/** Returns the decoded user, or sends a 401 and returns null. */
export function requireAuth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serverless invocations don't share memory, so the simulation derives all
 * record counts deterministically from the batch id instead of keeping state.
 */
export function seedFrom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
