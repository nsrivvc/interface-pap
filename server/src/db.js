// The one Neon Postgres connection the whole server shares. If DATABASE_URL
// is missing the app still boots in "local mode" — admin/12345 login, empty
// tables — instead of crashing, which is handy for UI-only development.
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

export const hasDb = Boolean(process.env.DATABASE_URL);

if (!hasDb) {
  console.warn(
    'DATABASE_URL is not set — running in local mode (admin/12345 login, empty tables). ' +
      'Copy server/.env.example to server/.env and paste your Neon connection string to enable the database.'
  );
}

function noDb() {
  throw new Error('Database not connected — set DATABASE_URL in server/.env first.');
}

export const sql = hasDb
  ? neon(process.env.DATABASE_URL)
  : Object.assign(() => noDb(), { query: () => noDb() });
