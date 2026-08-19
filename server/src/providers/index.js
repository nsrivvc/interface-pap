// Source API registry.
//
// The upstream API is not assumed to be NatGasHub. Each API this project can
// pull from gets ONE file in this folder describing it, and this registry picks
// which one is active. Everything else — dispatching workflows, naming tables,
// labelling feeds in the UI — reads from the active provider, so swapping APIs
// is a config change plus one new file, not a hunt through the codebase.
//
// ---------------------------------------------------------------------------
// ADDING A NEW API
// ---------------------------------------------------------------------------
// 1. Copy natgashub.js to <your-api>.js and fill in the shape below.
// 2. Register it in PROVIDERS.
// 3. Set PIPELINE_PROVIDER=<your-api> in server/.env.
// 4. Mirror the feed labels in client/src/providers/ so the UI names match.
//
// Provider shape:
//
//   {
//     key, label, description,
//     repo: { slug, ref } | null,        // where the transformation workflows live
//     finalTables: { core, locations, rates },   // cross-feed Stage 5 outputs
//     feeds: {
//       <feedKey>: {
//         label, shortLabel,
//         sourcePipeline,                // human name of the upstream pipeline
//         workflows: { pipeline, ingest } | null,   // null = cannot dispatch
//         tables: {
//           bronze:         { table, orderBy? },
//           silverStaging:  { locations, core, rates } | null,
//           recDel:         { table, orderBy? } | null,
//           masterCapacity: { core, locations, rates } | null,
//         },
//       },
//     },
//   }
//
// A null table group means the feed stops before that stage (Index of Customers
// has no Stage 3-5, for example). `orderBy` is the column the Table Viewer
// sorts a table by; omit it and it falls back to `id`.
import natgashub from './natgashub.js';
import local from './local.js';

export const PROVIDERS = { natgashub, local };

const REQUESTED = process.env.PIPELINE_PROVIDER || 'natgashub';

if (!PROVIDERS[REQUESTED]) {
  const known = Object.keys(PROVIDERS).join(', ');
  throw new Error(
    `PIPELINE_PROVIDER="${REQUESTED}" is not a known source API. Add a file to ` +
      `server/src/providers/ and register it, or pick one of: ${known}.`
  );
}

/** The API this server is currently pulling from. */
export const provider = PROVIDERS[REQUESTED];

/** Feed keys in the order the provider lists them. */
export const FEED_KEYS = Object.keys(provider.feeds);

/** One feed, or a clear error naming the feeds this API does have. */
export function feed(key) {
  const f = provider.feeds[key];
  if (!f) {
    throw new Error(
      `Unknown source "${key}" for ${provider.label}. This API has: ${FEED_KEYS.join(', ')}.`
    );
  }
  return f;
}

/** Feed metadata for the UI — no table or workflow internals. */
export function feedSummaries() {
  return FEED_KEYS.map((key) => ({
    key,
    label: provider.feeds[key].label,
    shortLabel: provider.feeds[key].shortLabel,
    sourcePipeline: provider.feeds[key].sourcePipeline,
  }));
}
