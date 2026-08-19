// Source API registry (UI side).
//
// The upstream API is not assumed to be NatGasHub. Each API gets ONE file in
// this folder; this picks the active one. Feed labels, chips, badges and the
// workflow files the panel polls all read from here, so renaming a feed or
// pointing at a different API is a one-file change.
//
// ADDING A NEW API
//   1. Copy natgashub.js to <your-api>.js and fill in its feeds.
//   2. Register it in PROVIDERS below.
//   3. Set VITE_PIPELINE_PROVIDER=<your-api> (client/.env) and the matching
//      PIPELINE_PROVIDER=<your-api> for the server — the feed KEYS must match,
//      since they're what /api/pipeline/* is called with.
import natgashub from './natgashub.js';
import local from './local.js';

const PROVIDERS = { natgashub, local };

const REQUESTED = import.meta.env?.VITE_PIPELINE_PROVIDER || 'natgashub';

if (!PROVIDERS[REQUESTED]) {
  throw new Error(
    `VITE_PIPELINE_PROVIDER="${REQUESTED}" is not a known source API. ` +
      `Add a file to client/src/providers/ and register it, or pick one of: ` +
      `${Object.keys(PROVIDERS).join(', ')}.`
  );
}

/** The API the interface is currently pointed at. */
export const provider = PROVIDERS[REQUESTED];

/** Feeds in the order they should be listed. */
export const FEEDS = provider.feeds;

/** feedKey -> the GitHub workflow file that runs its whole chain. */
export const FEED_WORKFLOW_FILES = Object.fromEntries(
  FEEDS.filter((f) => f.workflowFile).map((f) => [f.key, f.workflowFile])
);
