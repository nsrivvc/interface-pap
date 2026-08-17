// Triggers and tracks the pipeline workflows in the single nsrivvc/STAGE_3_4_5
// repo, which now holds ALL transformation logic (stages 1-5).
//
// Trigger model (see the Pipeline Workflow Runbook):
//   * firm / interruptible / awards -> one dispatch of <feed>(stage3_4_5).yml
//     runs the WHOLE chain for that feed: ingest (stage 1-2) -> stage 3 ->
//     stage 4 -> stage 5 core/locations/rates -> the three cross-feed finals,
//     all as jobs INSIDE that single run.
//   * index (IOC) has no stages 3-5, so its end-to-end is bronze_ingest_ioc.yml.
//   * The Manual Workflow panel dispatches the ingest-only bronze_ingest_*.yml.
// The old two-repo repository_dispatch handoff is gone — prefer
// workflow_dispatch everywhere.
const REPO =
  process.env.PIPELINE_GITHUB_REPO ||
  process.env.STAGE12_GITHUB_REPO ||
  'nsrivvc/STAGE_3_4_5';
const REF = process.env.PIPELINE_GITHUB_REF || process.env.STAGE12_GITHUB_REF || 'main';

// End-to-end workflow per feed (one dispatch = every stage for that feed)
const PIPELINE_WORKFLOWS = {
  firm: 'firm(stage3_4_5).yml',
  interruptible: 'interruptible(stage3_4_5).yml',
  awards: 'awards(stage3_4_5).yml',
  index: 'bronze_ingest_ioc.yml', // IOC stops after stage 2
};

// Ingest-only workflows (Manual Workflow panel, stage 1-2 only)
const INGEST_WORKFLOWS = {
  firm: 'bronze_ingest_firm.yml',
  interruptible: 'bronze_ingest_interruptibles.yml',
  awards: 'bronze_ingest_awards.yml',
  index: 'bronze_ingest_ioc.yml',
};

const ALL_SOURCES = Object.keys(PIPELINE_WORKFLOWS);

const KNOWN_WORKFLOWS = new Set([
  'bronze_ingest.yml',
  ...Object.values(INGEST_WORKFLOWS),
  ...Object.values(PIPELINE_WORKFLOWS),
]);

// encodeURIComponent leaves ( ) alone, but the GitHub API wants them encoded
// in workflow file paths — firm%28stage3_4_5%29.yml.
const wfPath = (file) =>
  encodeURIComponent(file).replace(/\(/g, '%28').replace(/\)/g, '%29');

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'interface-pap',
  };
}

function requireToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set — add a GitHub token with Actions read/write on ' +
        `${REPO} to server/.env to trigger the pipeline workflows.`
    );
  }
  return token;
}

async function dispatch(file, token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${wfPath(file)}/dispatches`,
    {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: REF }),
    }
  );
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch of ${file} failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/** Dispatch each selected source's end-to-end pipeline workflow. */
export async function triggerPipeline(sources) {
  const token = requireToken();
  const selected = ALL_SOURCES.filter((k) => (sources || []).includes(k));
  if (!selected.length) throw new Error('No valid sources selected.');

  const files = selected.map((k) => PIPELINE_WORKFLOWS[k]);
  for (const file of files) await dispatch(file, token);
  return { repo: REPO, ref: REF, dispatched: files };
}

/** Dispatch one source's ingest-only (stage 1-2) workflow. */
export async function triggerIngest(source) {
  const token = requireToken();
  const file = INGEST_WORKFLOWS[source];
  if (!file) throw new Error(`Unknown source "${source}".`);
  await dispatch(file, token);
  return { repo: REPO, ref: REF, dispatched: [file] };
}

/**
 * Live status of a dispatch: for each dispatched workflow file, the newest run
 * created since `sinceIso` plus its jobs. Stages 3-5 are jobs INSIDE each
 * feed's run now (named "stage 3 - bronze to silver / run", "final - rates /
 * run", …), so there is no separate Silver run to track.
 */
export async function pipelineRunStatus(files, sinceIso) {
  const token = requireToken();
  const wanted = (files || []).filter((f) => KNOWN_WORKFLOWS.has(f));
  if (!wanted.length) throw new Error('No known workflow files requested.');
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const headers = ghHeaders(token);

  const jobsOf = async (run) => {
    try {
      const res = await fetch(`${run.jobs_url}?per_page=50`, { headers });
      if (!res.ok) return [];
      return ((await res.json()).jobs || []).map((j) => ({
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
      }));
    } catch {
      return [];
    }
  };

  const runs = await Promise.all(
    wanted.map(async (file) => {
      const res = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/${wfPath(file)}/runs?per_page=1`,
        { headers }
      );
      if (!res.ok) return { file, run: null, jobs: [] };
      const run = (await res.json()).workflow_runs?.[0];
      if (!run || Date.parse(run.created_at) < since) return { file, run: null, jobs: [] };
      return {
        file,
        run: {
          name: run.name,
          status: run.status, // queued | in_progress | completed
          conclusion: run.conclusion, // success | failure | cancelled | null
          url: run.html_url,
          createdAt: run.created_at,
        },
        jobs: await jobsOf(run),
      };
    })
  );

  return { repo: REPO, runs };
}

/**
 * Cancel the in-flight runs of a dispatch: any not-yet-completed run of the
 * dispatched files created since `sinceIso`.
 */
export async function cancelPipelineRuns(files, sinceIso) {
  const token = requireToken();
  const wanted = (files || []).filter((f) => KNOWN_WORKFLOWS.has(f));
  if (!wanted.length) throw new Error('No known workflow files requested.');
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const headers = ghHeaders(token);

  let cancelled = 0;
  for (const file of wanted) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${REPO}/actions/workflows/${wfPath(file)}/runs?per_page=1`,
        { headers }
      );
      if (!res.ok) continue;
      const run = (await res.json()).workflow_runs?.[0];
      if (run && Date.parse(run.created_at) >= since && run.status !== 'completed') {
        const cancel = await fetch(
          `https://api.github.com/repos/${REPO}/actions/runs/${run.id}/cancel`,
          { method: 'POST', headers }
        );
        if (cancel.status === 202) cancelled += 1;
      }
    } catch {
      // unreachable — skip this file
    }
  }
  return { cancelled };
}
