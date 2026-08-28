// Vercel's doorway to the backend.
//
// Vercel turns any file in api/ into a serverless function: it takes the
// file's default export and calls it as handler(req, res) for each request.
// The import below RUNS server/src/index.js, which builds the Express app
// with every route registered — and since an Express app is itself a
// (req, res) function, exporting it is all Vercel needs.
//
// Flow: the deployed React site (static files in the browser) calls
// /api/... → vercel.json rewrites it here → Express matches the route →
// queries Neon → sends back the JSON the UI renders. Same code as local
// dev, so hosted and local behavior never drift.
//
// Requires the server's env vars in the Vercel project settings:
// DATABASE_URL, JWT_SECRET, GITHUB_TOKEN, PIPELINE_GITHUB_REPO/REF,
// POWERBI_* (optional), SOURCE_API_BASE (optional).
import app from '../server/src/index.js';

export default app;
