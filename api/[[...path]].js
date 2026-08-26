// Vercel catch-all: every /api/* request runs the SAME Express app as local
// dev (server/src/index.js) against the same Neon database — full parity
// instead of the old no-database demo handlers that lived in this folder.
//
// Express apps are (req, res) handlers, so the app itself is the function.
// Requires the server's env vars in the Vercel project settings:
//   DATABASE_URL, JWT_SECRET, GITHUB_TOKEN, PIPELINE_GITHUB_REPO,
//   PIPELINE_GITHUB_REF, POWERBI_* (optional), SOURCE_API_BASE (optional).
import app from '../server/src/index.js';

export default app;
