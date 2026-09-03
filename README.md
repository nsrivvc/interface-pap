# interface-pap — Pipeline Accelerator Program interface

A web app for running and watching a natural-gas data pipeline. React (Vite)
frontend + one Express API, with **all data — user accounts, warehouse tables,
reference data, scenarios — in one Neon Postgres database**. The heavy
transformation work (Stages 1–5) runs as GitHub Actions workflows in the
pipeline repo (`nsrivvc/STAGE_3_4_5`); this app triggers those runs and shows
their live status.

## The four tabs

| Tab | What you do there |
| --- | --- |
| **Reference Data** | Maintain the lookup tables every workflow relies on: which source API to use (with credentials + "connected" checks), Pipelines, Shippers, Locations, Rec-Del Pairings. Each is a real Neon table shown in an editable grid. |
| **Contract Workflow Dashboard** | Create **scenarios** (each pins choices from the reference data), build **workflows**, attach one scenario to a workflow, run it manually or on a daily schedule, and watch the GitHub Actions stages complete. |
| **Table Viewer** | Browse every warehouse table stage by stage, with row counts, filtering, and CSV / XLSX / Parquet downloads. |
| **Reports** | Power BI: embed a report, or generate a "gold" report from a filtered table view. |

## How it runs

- **Locally** — `npm run dev` starts the Express API on `:4000` and the Vite
  client on `:5173`. The client calls the API with relative `/api/...` paths
  (Vite proxies them).
- **Hosted (Vercel)** — the **same Express app** is served as one serverless
  function: `api/index.js` just re-exports it, and `vercel.json` rewrites every
  `/api/*` request to it. So local and hosted behavior can't drift apart.
  Set the env vars from `server/.env` in the Vercel project settings.

Two things don't work on Vercel by nature of serverless: the interval
scheduler (nothing stays alive between requests — daily times still fire while
the dashboard is open in a browser) and Parquet downloads (they read from
local disk).

## Setup

1. Install everything: `npm run install:all`
2. Copy `server\.env.example` to `server\.env`, paste your Neon
   `DATABASE_URL`, set a random `JWT_SECRET`.
3. Create the tables: `npm run db:init`  (safe to re-run — everything is
   `IF NOT EXISTS` / seed-only-when-empty)
4. Run it: `npm run dev` → open http://localhost:5173
   (local login `admin` / `12345` always works, even with no database)

## What each file does

### Root

| File | What it does |
| --- | --- |
| `package.json` | Scripts (`dev`, `db:init`, `install:all`) and the server's dependencies (Vercel installs from here). |
| `vercel.json` | Vercel config: build the client, serve `client/dist`, send `/api/*` to the Express function, everything else to the SPA. |
| `api/index.js` | The entire Vercel backend — one line that re-exports the Express app from `server/src/index.js`. |

### Server (`server/`)

| File | What it does |
| --- | --- |
| `schema.sql` | Every Neon table in one place: users, stage tables, workflows/runs, the reference tables (shipping, pipeline_attributes, rec_del_pairings, location_purpose_code), source_config + source_credentials + source_feeds, and scenarios. All idempotent. |
| `scripts/init-db.js` | Applies `schema.sql` to Neon and seeds the admin account. |
| `scripts/seed-final-core.js` | Drops + recreates `final_core_master_capacity` with sample rows. |
| `scripts/test-powerbi-auth.js` | Checks the Power BI service-principal login chain works, without printing secrets. |
| `src/index.js` | **The API.** All routes live here: auth, table listing/viewing, Configure Components (the editable reference grids), source config + credentials + verify, scenarios, pipeline triggers/status, Power BI, workflows. Exports the app; only calls `listen()` when not on Vercel. |
| `src/db.js` | The Neon connection. If `DATABASE_URL` isn't set, the app runs in "local mode" (admin login, empty tables) instead of crashing. |
| `src/auth.js` | JWT sign + the `requireAuth` middleware every API route uses. |
| `src/pipeline.js` | The simulated in-app pipeline: dummy source retrieval and Stages 1–5 (validate → normalize → enrich → aggregate → publish), used by the "Full Pipeline" workflow and local mode. |
| `src/github.js` | Talks to the GitHub API: dispatches the real pipeline workflows in the STAGE_3_4_5 repo, polls run/job status, cancels runs. |
| `src/scheduler.js` | Interval timers that re-run scheduled workflows (local server only — see the Vercel note above). |
| `src/downloads.js` | Builds CSV/XLSX downloads from Postgres; finds Parquet files exported by the pipeline repo on disk. |
| `src/powerbi.js` | Azure AD service-principal token + pushing a table into a Power BI workspace dataset and minting an embed token. |
| `src/providers/` | One file per upstream API (`natgashub.js`, `local.js` mock) + a registry (`index.js`) that picks the active one via `PIPELINE_PROVIDER`. Everything feed-specific (names, workflow files, physical tables) lives only here. |

### Client (`client/src/`)

| File | What it does |
| --- | --- |
| `main.jsx` | Boots React: router + auth provider + styles. |
| `App.jsx` | The routes: `/login`, `/register`, `/` (dashboard), `/reference`, `/tables`, `/tables/:name`, `/reports` — all behind a login check. |
| `api.js` | Tiny fetch wrapper: adds the JWT header, throws readable errors, plus `apiDownload` for file downloads. |
| `auth-context.jsx` | Keeps "who is logged in" in React context; restores the session from the stored token on refresh. |
| `styles.css` | All styling (Value Creed look). One plain CSS file, no framework. |
| `grid-theme.js` | The shared AG Grid theme so every table in the app looks the same. |
| `workflow-defs.js` | Shared workflow vocabulary: stage definitions, source list, which tables belong to each stage, and load/save of workflows in localStorage. |
| `providers/` | UI-side mirror of the server's provider registry: feed labels, chips, and which workflow file each feed dispatches. |

### Client pages (`client/src/pages/`)

| File | What it does |
| --- | --- |
| `Login.jsx` / `Register.jsx` | The auth forms. |
| `Dashboard.jsx` | The Contract Workflow Dashboard shell — hero banner + `WorkflowPanel`. |
| `ReferenceData.jsx` | The Reference Data tab shell — hero banner + `ComponentsConfig`. |
| `TableViewer.jsx` | Stage-by-stage list of every warehouse table with row counts, grouped per workflow. |
| `TableView.jsx` | One table's rows in AG Grid: filtering, search, downloads, and the "gold report" / Power BI generation buttons. |
| `Reports.jsx` | Embeds a Power BI report via `VITE_POWERBI_EMBED_URL`. |

### Client components (`client/src/components/`)

| File | What it does |
| --- | --- |
| `Header.jsx` | Top nav bar: the four tabs + signed-in user + logout. |
| `ComponentsConfig.jsx` | The whole Reference Data UI. `Section` = a collapsible block (state remembered per browser). `SourceConfig` = the source cards, credentials form, connected/failed badges, test connection, and each source's feed table (technical name, endpoint path and on/off of its Firm, IT, Awards and IOC feeds). `ComponentTable` = one editable AG Grid over a reference table (add row, edit cells in place, delete). |
| `WorkflowPanel.jsx` | The whole dashboard UI. Top panel: create/list/delete **scenarios** (stacked dropdowns per reference point, ＋ adds another value). Bottom panel: create/edit/run **workflows** — name, one attached scenario (styled dropdown), sources, daily trigger time — plus live GitHub Actions run status while a pipeline executes. |

### Power BI helpers (`client/src/`)

| File | What it does |
| --- | --- |
| `powerbi.js` | Boots the embedded Power BI create/edit canvas from a table's filtered rows. |
| `powerbi-config.js` | Pure functions that shape the rows/columns into Power BI's expected config (testable, no browser). |
| `powerbi-author.js` | Auto-lays-out the starter report (card, slicer, charts, table) the first time. |
| `gold-report.js` | The no-Power-BI fallback: builds a self-contained HTML report of the filtered slice. |

## Key concepts, simply

- **Reference data** — five lookup tables, edited on their own tab. Grids read
  the live columns from Neon, so adding a column in Neon shows up in the UI
  automatically. The Source card is special: pick which API feeds the JSONs
  (Mock-Up NatGasHub / NatGasHub / Cortex), enter credentials for the real
  ones, and the server verifies and badges them "connected" or "failed".
  Every source serves the same four feeds — Firm, IT, Awards, IOC — under its
  own technical names and endpoint paths; each card lists them and its
  "configure feeds" link edits them in place (stored in `source_feeds`).
- **Scenario** — a saved, named bundle of reference-data choices (one source,
  one or more pipelines/shippers/locations/pairings). Created on the
  dashboard, stored in Neon (`scenarios.config` as JSON).
- **Workflow** — a named run configuration on the dashboard: which sources to
  pull, one attached scenario, and an optional daily trigger time. Stored in
  the browser (localStorage). Running one dispatches the real GitHub Actions
  pipelines and shows each stage's live status.
- **The pipeline itself** — lives in the `nsrivvc/STAGE_3_4_5` repo. This app
  only *triggers* it (via `GITHUB_TOKEN`) and *reads* what it writes to Neon.

## Environment variables (`server/.env`)

| Variable | Needed for |
| --- | --- |
| `DATABASE_URL` | Everything — the Neon connection. Without it: local demo mode. |
| `JWT_SECRET` | Signing login tokens. |
| `GITHUB_TOKEN`, `PIPELINE_GITHUB_REPO`, `PIPELINE_GITHUB_REF` | Triggering and watching the real pipeline runs. |
| `POWERBI_TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` / `WORKSPACE_ID` | The Power BI panel. |
| `SOURCE_API_BASE` | Where the Mock-Up NatGasHub API lives (default `http://localhost:8000`) — the base its feed paths hang off, used by the mock's Test Connection and the pipeline-options picker. The real sources take their base URL from their saved credentials instead. |
| `PIPELINE_PROVIDER` | Which provider file is active (default `natgashub`). |

On Vercel, set the same names in the project's Environment Variables.

## Connecting a different API

The upstream API is **not** assumed to be NatGasHub. Each API gets one file on
each side, and a registry picks the active one:

```
server/src/providers/natgashub.js   feeds, workflow files, physical tables
server/src/providers/local.js       offline mock — no API, no dispatch
client/src/providers/natgashub.js   feed labels + the workflow file per feed
```

To add an API: copy `natgashub.js` on **both** sides, register it in each
`providers/index.js`, and set `PIPELINE_PROVIDER` (server) +
`VITE_PIPELINE_PROVIDER` (client). Keep the feed keys identical on both sides.
