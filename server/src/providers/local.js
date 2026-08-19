// Local / mock source — no upstream API and no GitHub.
//
// Selected with PIPELINE_PROVIDER=local. Use it for offline demos and for
// developing the UI without a token or a warehouse: the feeds and tables keep
// the same shape as a real provider, but nothing dispatches. `workflows: null`
// is what makes triggerPipeline/triggerIngest refuse with a clear message
// instead of calling GitHub, and pipeline.js simulates the stages in memory.
//
// Copy this file as the starting point for a real API — see providers/index.js.
import natgashub from './natgashub.js';

// The mock API serves the same feed shapes into the same warehouse tables, so
// the table map is borrowed rather than duplicated. A real provider should
// spell its own tables out instead of importing another provider's.
const mockFeed = (key, label, shortLabel) => ({
  label,
  shortLabel,
  sourcePipeline: `Local-Mock-${label.replace(/\s+/g, '')}-Pipeline`,
  workflows: null, // nothing to dispatch — the stages are simulated in-process
  tables: natgashub.feeds[key].tables,
});

export default {
  key: 'local',
  label: 'Local mock API',
  description: 'Simulated feeds for offline development — no upstream API, no GitHub dispatch',
  repo: null,
  finalTables: natgashub.finalTables,
  feeds: {
    firm: mockFeed('firm', 'Firm', 'Firm'),
    interruptible: mockFeed('interruptible', 'Interruptible', 'IT'),
    awards: mockFeed('awards', 'Awards', 'Awards'),
    index: mockFeed('index', 'Index of Customers', 'IOC'),
  },
};
