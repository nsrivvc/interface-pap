// Triggers and tracks the pipeline workflows for the ACTIVE source API.
//
// Which API that is, what its feeds are called and which workflow file runs
// each one all come from server/src/providers/ — nothing here is specific to
// NatGasHub. Point PIPELINE_PROVIDER at a different file and this module
// dispatches that API's workflows instead.
//
// Trigger model (see the Pipeline Workflow Runbook):
//   * A feed's `workflows.pipeline` runs the WHOLE chain for that feed:
//     ingest (stage 1-2) -> stage 3 -> stage 4 -> stage 5 core/locations/rates
//     -> the three cross-feed finals, all as jobs INSIDE that single run.
//   * A feed with no stages 3-5 (Index of Customers) points `workflows.pipeline`
//     at its ingest file, so its end-to-end is just the ingest.
//   * The Manual Workflow panel dispatches `workflows.ingest` (stage 1-2 only).
// The old two-repo repository_dispatch handoff is gone — prefer
// workflow_dispatch everywhere.
import { provider, FEED_KEYS, feed } from './providers/index.js';
import { parseRunnerLog, summarizeWrites } from './runlog.js';

// Env still wins, so a fork or a test branch needs no code change.
const REPO =
  process.env.PIPELINE_GITHUB_REPO ||
  process.env.STAGE12_GITHUB_REPO ||
  provider.repo?.slug;
const REF =
  process.env.PIPELINE_GITHUB_REF || process.env.STAGE12_GITHUB_REF || provider.repo?.ref || 'main';

/** The workflow file for one feed, or a clear error if this API can't dispatch. */
function workflowFile(key, kind) {
  const { workflows, label } = feed(key);
  if (!workflows) {
    throw new Error(
      `${provider.label} has no GitHub workflows — "${label}" cannot be dispatched. ` +
        'Set PIPELINE_PROVIDER to an API that defines them.'
    );
  }
  return workflows[kind];
}

// Every workflow file this provider knows about, used to sanity-check the
// files a status/cancel request asks for.
const KNOWN_WORKFLOWS = new Set([
  'bronze_ingest.yml', // legacy all-feeds ingest, still dispatchable by hand
  ...FEED_KEYS.flatMap((k) => Object.values(provider.feeds[k].workflows || {})),
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
  if (!REPO) {
    throw new Error(
      `${provider.label} has no pipeline repo configured — set PIPELINE_GITHUB_REPO in ` +
        'server/.env, or give the provider a `repo` in server/src/providers/.'
    );
  }
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
  const selected = FEED_KEYS.filter((k) => (sources || []).includes(k));
  if (!selected.length) throw new Error('No valid sources selected.');

  const files = selected.map((k) => workflowFile(k, 'pipeline'));
  for (const file of files) await dispatch(file, token);
  return { repo: REPO, ref: REF, dispatched: files };
}

/** Dispatch one source's ingest-only (stage 1-2) workflow. */
export async function triggerIngest(source) {
  const token = requireToken();
  const file = workflowFile(source, 'ingest');
  await dispatch(file, token);
  return { repo: REPO, ref: REF, dispatched: [file] };
}

// ---------- Write semantics from job logs ----------
//
// A job's status says whether it worked; only its LOG says what it did to the
// tables — appended, preserved, rebuilt or skipped. runlog.js does the reading;
// this fetches the text.
//
// Cache: a COMPLETED job's log is immutable, so parse it once and keep it. The
// dashboard polls every few seconds, and without this each poll would re-download
// every job's log for the whole run. In-progress jobs are re-fetched each time,
// which is the point — that's what makes the write modes appear live. On Vercel
// this is per-instance and simply starts cold, which costs a re-fetch, not
// correctness.
const logCache = new Map(); // jobId -> parsed transformations (completed jobs only)
const LOG_CACHE_MAX = 400;

/** Raw log text for one job, or "" if GitHub won't serve it (yet). */
async function jobLogText(jobId, headers) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`, {
      headers,
      redirect: 'follow',
    });
    // 404 is routine for a job that has not produced output yet — not an error.
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Parsed write semantics for one job. Completed jobs are memoized; running
 * jobs are re-read every poll so the badges fill in as the run proceeds.
 */
async function jobWrites(job, headers) {
  const done = job.status === 'completed';
  if (done && logCache.has(job.id)) return logCache.get(job.id);

  const text = await jobLogText(job.id, headers);
  if (!text) return [];
  const { transformations } = parseRunnerLog(text);

  if (done) {
    if (logCache.size >= LOG_CACHE_MAX) logCache.delete(logCache.keys().next().value);
    logCache.set(job.id, transformations);
  }
  return transformations;
}

/**
 * Live status of a dispatch: for each dispatched workflow file, the newest run
 * created since `sinceIso` plus its jobs. Stages 3-5 are jobs INSIDE each
 * feed's run now (named "stage 3 - bronze to silver / run", "final - rates /
 * run", …), so there is no separate Silver run to track.
 *
 * With `withWrites`, each job's log is also read for the write semantics of the
 * transformations it ran, and the whole dispatch is rolled up into `writes` —
 * which table was preserved, which was rebuilt, and how many rows each moved.
 * Log reading is best effort: it never fails the status call, so the stage
 * pills keep updating even if the logs are unavailable.
 */
export async function pipelineRunStatus(files, sinceIso, { withWrites = false } = {}) {
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
        id: j.id,
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

  if (!withWrites) return { repo: REPO, runs };

  // Read every started job's log. Queued jobs have nothing to say yet.
  const jobs = runs.flatMap((x) => x.jobs || []).filter((j) => j.status !== 'queued');
  const perJob = await Promise.all(jobs.map((j) => jobWrites(j, headers).catch(() => [])));
  return { repo: REPO, runs, writes: summarizeWrites(perJob.flat()) };
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
