// Triggers the Stage 1/2 ingestion workflows (GitHub Actions) in the
// json--bronze--postgres repo (renamed on GitHub to STAGE_1_-_STAGE_2).
//
// All four sources selected -> one dispatch of the bronze_ingest.yml
// orchestrator (it fans out to the per-source workflows itself); any other
// selection dispatches each selected source's own workflow.
const REPO = process.env.STAGE12_GITHUB_REPO || 'nsrivvc/STAGE_1_-_STAGE_2';
const REF = process.env.STAGE12_GITHUB_REF || 'main';

const SOURCE_WORKFLOWS = {
  firm: 'bronze_ingest_firm.yml',
  interruptible: 'bronze_ingest_interruptibles.yml',
  awards: 'bronze_ingest_awards.yml',
  index: 'bronze_ingest_ioc.yml',
};
const ALL_SOURCES = Object.keys(SOURCE_WORKFLOWS);

async function dispatch(file, token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${encodeURIComponent(file)}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'interface-pap',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    }
  );
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch of ${file} failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/** Dispatch the right ingestion workflow(s) for the selected source keys. */
export async function triggerStage12(sources) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set — add a GitHub personal access token with Actions ' +
        'write access to server/.env to trigger the ingestion workflows.'
    );
  }
  const selected = ALL_SOURCES.filter((k) => (sources || []).includes(k));
  if (!selected.length) throw new Error('No valid sources selected.');

  const files =
    selected.length === ALL_SOURCES.length
      ? ['bronze_ingest.yml']
      : selected.map((k) => SOURCE_WORKFLOWS[k]);

  for (const file of files) await dispatch(file, token);
  return { repo: REPO, ref: REF, dispatched: files };
}

const KNOWN_WORKFLOWS = new Set(['bronze_ingest.yml', ...Object.values(SOURCE_WORKFLOWS)]);

/** Latest run status for each dispatched workflow file, for live UI updates. */
export async function stage12RunStatus(files) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  const wanted = (files || []).filter((f) => KNOWN_WORKFLOWS.has(f));
  if (!wanted.length) throw new Error('No known workflow files requested.');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'interface-pap',
  };
  const runs = await Promise.all(
    wanted.map(async (file) => {
      const res = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=1`,
        { headers }
      );
      if (!res.ok) return { file, status: 'unknown', conclusion: null, url: null };
      const run = (await res.json()).workflow_runs?.[0];
      if (!run) return { file, status: 'queued', conclusion: null, url: null };
      return {
        file,
        name: run.name,
        status: run.status, // queued | in_progress | completed
        conclusion: run.conclusion, // success | failure | cancelled | null
        url: run.html_url,
        startedAt: run.run_started_at,
      };
    })
  );
  return { repo: REPO, runs };
}
