# interface-pap

Value Creed–styled data pipeline interface: React (Vite) frontend + Express API, with **all data — user accounts, pipeline tables, and workflow config — in one Neon Postgres database**.

## Features

- **Accounts** — register / login (bcrypt + JWT), users stored in Neon
- **Dashboard** — card view of every pipeline table with live row counts; click through to browse rows
- **Retrieve Source** — generates a dummy JSON batch of CTRM-style trade records into `source_data`
- **Stage 1–5 buttons** — staged transformations, each reading the previous stage's table:
  1. Validation → `stage1_validated`
  2. Normalization → `stage2_normalized`
  3. Enrichment → `stage3_enriched`
  4. Aggregation → `stage4_aggregated`
  5. Publish → `stage5_published`
- **Workflows** — "Activate Workflow" runs retrieve + all 5 stages end to end with per-step logging (`workflow_runs`). Once a workflow has completed, you can set its timing (run every N minutes) and the server scheduler runs it automatically.

## Setup

1. **Install dependencies** (root, server, and client):

   ```
   npm run install:all
   ```

2. **Connect Neon** — create a project at [neon.tech](https://neon.tech), then:

   ```
   copy server\.env.example server\.env
   ```

   Edit `server/.env` and paste your Neon connection string into `DATABASE_URL` (and set a random `JWT_SECRET`).

3. **Create the tables** in Neon:

   ```
   npm run db:init
   ```

4. **Run the app** (starts API on :4000 and client on :5173):

   ```
   npm run dev
   ```

   Open http://localhost:5173, create an account, and you're in.

## Structure

```
server/           Express API
  schema.sql      All Neon tables (users, source, stage1-5, workflows, runs)
  src/providers/  One file per source API — see "Connecting a different API"
  src/pipeline.js Dummy source retrieval + the 5 stage transformations
  src/scheduler.js Interval-based workflow scheduler
client/           React (Vite) app, Value Creed styling
  src/providers/  UI-side feed labels for each source API
  src/pages/      Login, Register, Dashboard, TableView
  src/components/ Header, WorkflowPanel
```

## Connecting a different API

The upstream API is **not** assumed to be NatGasHub. Each API gets one file on
each side, and a registry picks the active one:

```
server/src/providers/natgashub.js   feeds, workflow files, physical tables
server/src/providers/local.js       offline mock — no API, no dispatch
client/src/providers/natgashub.js   feed labels + the workflow file per feed
```

Nothing outside those files names a feed, a bronze/silver table, or a workflow
`.yml`. To add an API:

1. Copy `natgashub.js` on **both** sides to `<your-api>.js` and fill it in.
2. Register it in the `PROVIDERS` map in each `providers/index.js`.
3. Set `PIPELINE_PROVIDER=<your-api>` (server/.env) and
   `VITE_PIPELINE_PROVIDER=<your-api>` (client/.env).

Keep the feed **keys** identical on both sides — they're what `/api/pipeline/*`
is called with. `GET /api/provider` reports which API the server is using.
Setting an unregistered name fails at startup with the list of valid ones.
