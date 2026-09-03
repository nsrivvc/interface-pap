# interface-pap — Pipeline Capacity Accelerator

A web app for running and watching a natural-gas data pipeline. React (Vite)
frontend + one Express API, with **all data — user accounts, warehouse tables,
reference data, scenarios — in one Neon Postgres database**. The heavy
transformation work (Stages 1–5) runs as GitHub Actions workflows in the
pipeline repo (`nsrivvc/Python-Engine-pca`); this app triggers those runs and shows
their live status.
