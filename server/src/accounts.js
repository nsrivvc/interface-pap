// Accounts and what each kind of account may do — the one place roles live.
//
// Two roles:
//   admin  — the whole interface: reference data, scenarios, workflows and
//            pipeline triggers, source configuration, Power BI, and account
//            management itself.
//   viewer — read-only. The Table Viewer and its CSV/XLSX/Parquet downloads,
//            and nothing else. Every write route refuses them.
//
// How a route picks its gate:
//   requireAuth   — any signed-in account (the Table Viewer + downloads)
//   requireAdmin  — admins only (everything else)
//
// requireAdmin re-reads the role from the database rather than trusting the
// role claim inside the token, so demoting someone takes effect on their very
// next request instead of whenever their week-old token happens to expire.
import bcrypt from 'bcryptjs';
import { sql, hasDb } from './db.js';
import { signToken, requireAuth } from './auth.js';

export const ROLES = ['admin', 'viewer'];
export const DEFAULT_ROLE = 'viewer'; // what a public sign-up gets

export const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer' };
export const ROLE_DESCRIPTION = {
  admin: 'Full access — reference data, scenarios, workflows, reports and accounts.',
  viewer: 'Read-only — browse the Table Viewer and download tables.',
};

const isRole = (role) => ROLES.includes(role);

// The built-in admin that works with or without a database, so the app can
// never lock itself out (id 0 never collides with a users.id from the sequence).
export const LOCAL_ADMIN = { id: 0, name: 'Admin', email: 'admin', role: 'admin' };

// ---------- the users table ----------
// The role column arrives as 'admin' and only THEN drops its default to viewer:
// every account that existed before roles did already had full access, so it
// keeps it, while accounts created from here on start out read-only.
const USERS_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     name          TEXT NOT NULL,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`,
  `ALTER TABLE users ALTER COLUMN role SET DEFAULT '${DEFAULT_ROLE}'`,
];

let ensured = false;
async function ensureUsers() {
  if (ensured) return true;
  if (!hasDb) return false;
  try {
    for (const ddl of USERS_DDL) await sql.query(ddl);
    ensured = true;
    return true;
  } catch {
    return false;
  }
}

const publicUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: isRole(row.role) ? row.role : DEFAULT_ROLE,
});

/**
 * The role this account has RIGHT NOW, from the database — not the (possibly
 * stale) claim in the caller's token. Falls back to the token's own claim only
 * when there is no database to ask.
 */
export async function currentRole(user) {
  if (!user) return null;
  if (user.id === LOCAL_ADMIN.id) return 'admin'; // built-in admin, never in the table
  if (!(await ensureUsers())) return isRole(user.role) ? user.role : DEFAULT_ROLE;
  const [row] = await sql`SELECT role FROM users WHERE id = ${user.id}`;
  if (!row) return null; // account deleted — its old token stops being an admin
  return isRole(row.role) ? row.role : DEFAULT_ROLE;
}

/** Signed in AND an admin. Everything that writes or runs something uses this. */
export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    currentRole(req.user)
      .then((role) => {
        if (role !== 'admin') {
          return res
            .status(403)
            .json({ error: 'Admins only — this account has read-only access.' });
        }
        req.user.role = role;
        next();
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  });
}

// How many admins exist, so the last one can't be demoted or removed and lock
// everyone out of the configuration. The built-in admin is the +1: it isn't a
// row in the table but it can always sign in, with or without a database. Drop
// that term if LOCAL_ADMIN is ever retired.
async function adminCount() {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`;
  return (row?.n || 0) + 1;
}

const withMeta = (row) => ({ ...publicUser(row), createdAt: row.created_at, builtIn: false });

// ---------- routes ----------
// `wrap` is the same 400-on-throw helper the rest of the API uses, passed in
// from index.js so error handling stays identical across every route.
export function registerAccountRoutes(app, wrap) {
  // Public sign-up — always read-only; an admin promotes from the Accounts tab
  app.post('/api/auth/register', wrap(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) throw new Error('Name, email and password are required.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    await ensureUsers();
    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (existing.length) throw new Error('An account with that email already exists.');
    const hash = await bcrypt.hash(password, 10);
    const [user] = await sql`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (${name}, ${email.toLowerCase()}, ${hash}, ${DEFAULT_ROLE})
      RETURNING id, name, email, role`;
    res.json({ token: signToken(publicUser(user)), user: publicUser(user) });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const { email, password } = req.body;
    if ((email || '').toLowerCase() === LOCAL_ADMIN.email && password === '12345') {
      return res.json({ token: signToken(LOCAL_ADMIN), user: LOCAL_ADMIN });
    }
    await ensureUsers();
    const [user] = await sql`
      SELECT id, name, email, role, password_hash FROM users
      WHERE email = ${(email || '').toLowerCase()}`;
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const safe = publicUser(user);
    res.json({ token: signToken(safe), user: safe });
  }));

  // Who am I — with the role read fresh, so a promotion or demotion reaches the
  // UI on the next page load instead of waiting for a new sign-in.
  app.get('/api/auth/me', requireAuth, wrap(async (req, res) => {
    const role = await currentRole(req.user);
    if (!role) return res.status(401).json({ error: 'Account no longer exists.' });
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role } });
  }));

  // ---------- account management (admins only) ----------
  app.get('/api/accounts', requireAdmin, wrap(async (req, res) => {
    const builtIn = { ...LOCAL_ADMIN, createdAt: null, builtIn: true };
    if (!(await ensureUsers())) {
      // No database — the built-in admin is the only account there is
      return res.json({ accounts: [builtIn], roles: ROLES });
    }
    const rows = await sql`
      SELECT id, name, email, role, created_at FROM users ORDER BY created_at, id`;
    res.json({ accounts: [builtIn, ...rows.map(withMeta)], roles: ROLES });
  }));

  app.post('/api/accounts', requireAdmin, wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || DEFAULT_ROLE);
    if (!name || !email || !password) throw new Error('Name, email and password are required.');
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');
    if (!isRole(role)) throw new Error('Unknown role.');
    if (!(await ensureUsers())) {
      throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
    }
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length) throw new Error('An account with that email already exists.');
    const hash = await bcrypt.hash(password, 10);
    const [user] = await sql`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (${name}, ${email}, ${hash}, ${role})
      RETURNING id, name, email, role, created_at`;
    res.json({ account: withMeta(user) });
  }));

  app.put('/api/accounts/:id/role', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const role = String(req.body?.role || '');
    if (!isRole(role)) throw new Error('Unknown role.');
    if (id === LOCAL_ADMIN.id) throw new Error('The built-in admin account cannot be changed.');
    if (id === req.user.id) throw new Error('You cannot change your own role.');
    if (!(await ensureUsers())) {
      throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
    }
    const [target] = await sql`SELECT id, role FROM users WHERE id = ${id}`;
    if (!target) throw new Error('No such account.');
    if (target.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) {
      throw new Error('This is the last admin account — promote someone else first.');
    }
    const [user] = await sql`
      UPDATE users SET role = ${role} WHERE id = ${id}
      RETURNING id, name, email, role, created_at`;
    res.json({ account: withMeta(user) });
  }));

  app.delete('/api/accounts/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === LOCAL_ADMIN.id) throw new Error('The built-in admin account cannot be removed.');
    if (id === req.user.id) throw new Error('You cannot remove your own account.');
    if (!(await ensureUsers())) {
      throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
    }
    const [target] = await sql`SELECT id, role FROM users WHERE id = ${id}`;
    if (!target) throw new Error('No such account.');
    if (target.role === 'admin' && (await adminCount()) <= 1) {
      throw new Error('This is the last admin account — promote someone else first.');
    }
    await sql`DELETE FROM users WHERE id = ${id}`;
    res.json({ ok: true });
  }));
}
