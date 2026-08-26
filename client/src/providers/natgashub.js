// NatGasHub (NGH) — UI-side description of the source API.
//
// The server's server/src/providers/natgashub.js is the authority on tables and
// workflow dispatch; this file carries only what the interface needs to draw:
// what each feed is called and which workflow file backs it. Keep the feed keys
// identical on both sides — they're what the API calls are keyed by.
export default {
  key: 'natgashub',
  label: 'NatGasHub',

  // `lastStage` is where a feed's pipeline stops. IOC has no Stage 3-5 logic,
  // so it contributes no tables past Stage 2 and its end-to-end workflow is
  // just the ingest.
  //
  // `stage3Phases` marks a feed whose Stage 3 runs in phases — duplicates
  // dropped, amendments applied and multi-part records decomposed, each landing
  // its own table, before the standardized ones are built. A feed without it
  // (Awards) goes straight to standardization.
  feeds: [
    {
      key: 'firm',
      label: 'Firm',
      shortLabel: 'Firm',
      sourcePipeline: 'NGH-gTran-Firms-API-Pipeline',
      workflowFile: 'firm(stage3_4_5).yml',
      lastStage: 5,
      stage3Phases: true,
    },
    {
      key: 'interruptible',
      label: 'Interruptible',
      shortLabel: 'IT',
      sourcePipeline: 'NGH-gTran-Interruptibles-API-Pipeline',
      workflowFile: 'interruptible(stage3_4_5).yml',
      lastStage: 5,
      stage3Phases: true,
    },
    {
      key: 'awards',
      label: 'Awards',
      shortLabel: 'Awards',
      sourcePipeline: 'NGH-gExchange-Awards-API-Pipeline',
      workflowFile: 'awards(stage3_4_5).yml',
      lastStage: 5,
    },
    {
      key: 'index',
      label: 'Index of Customers',
      shortLabel: 'IOC',
      sourcePipeline: 'NGH-IndexOfCustomers-API-Pipeline',
      workflowFile: 'bronze_ingest_ioc.yml',
      lastStage: 2,
    },
  ],
};
