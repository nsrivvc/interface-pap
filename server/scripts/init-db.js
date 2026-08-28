// One-shot database setup (npm run db:init): applies schema.sql to Neon
// statement by statement and seeds the default admin account (admin/12345).
// Everything in the schema is IF NOT EXISTS / seed-when-empty, so re-running
// is always safe.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env and paste your Neon connection string.');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

// Split on semicolons at end of statements (schema contains no functions/procedures)
const statements = schema
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  await sql.query(statement);
}

// Seed the default admin account (login: admin / 12345)
const adminHash = await bcrypt.hash('12345', 10);
await sql`
  INSERT INTO users (name, email, password_hash)
  VALUES ('Admin', 'admin', ${adminHash})
  ON CONFLICT (email) DO NOTHING`;

console.log(`Applied ${statements.length} statements. Neon database is ready (admin account: admin / 12345).`);
