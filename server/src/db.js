import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env and paste your Neon connection string.');
  process.exit(1);
}

export const sql = neon(process.env.DATABASE_URL);
