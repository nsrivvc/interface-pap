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
  src/pipeline.js Dummy source retrieval + the 5 stage transformations
  src/scheduler.js Interval-based workflow scheduler
client/           React (Vite) app, Value Creed styling
  src/pages/      Login, Register, Dashboard, TableView
  src/components/ Header, WorkflowPanel
```
