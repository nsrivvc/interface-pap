import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

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

console.log(`Applied ${statements.length} statements. Neon database is ready.`);
