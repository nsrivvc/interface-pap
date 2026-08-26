// Local / mock source — the offline counterpart to a real API.
//
// Selected with VITE_PIPELINE_PROVIDER=local. Same feeds and same stage depth,
// but no workflow files: the panel has nothing to dispatch and nothing to poll,
// which is what you want when developing the UI without GitHub.
export default {
  key: 'local',
  label: 'Local mock API',
  feeds: [
    { key: 'firm', label: 'Firm', shortLabel: 'Firm', sourcePipeline: 'Local-Mock-Firm-Pipeline', workflowFile: null, lastStage: 5, stage3Phases: true },
    { key: 'interruptible', label: 'Interruptible', shortLabel: 'IT', sourcePipeline: 'Local-Mock-Interruptible-Pipeline', workflowFile: null, lastStage: 5, stage3Phases: true },
    { key: 'awards', label: 'Awards', shortLabel: 'Awards', sourcePipeline: 'Local-Mock-Awards-Pipeline', workflowFile: null, lastStage: 5 },
    { key: 'index', label: 'Index of Customers', shortLabel: 'IOC', sourcePipeline: 'Local-Mock-IndexOfCustomers-Pipeline', workflowFile: null, lastStage: 2 },
  ],
};
