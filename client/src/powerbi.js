// Embedded Power BI quick-create: turns the grid's filtered rows into the
// datasetCreateConfig shape and boots the editing canvas into a container.
// Contract per Microsoft's "Embed a quick report" doc: AAD token only, embed
// URL /quickcreate, data inline as a single table of string rows (16MB cap),
// table name fixed to "Table".
import { service, factories } from 'powerbi-client';
import 'powerbi-report-authoring'; // augments Page/VisualDescriptor with authoring APIs

export { goldDatasetPayload, createReportConfig, editReportConfig } from './powerbi-config';
export { ensureStarterReport } from './powerbi-author';


export const pbiService = new service.Service(
  factories.hpmFactory,
  factories.wpmpFactory,
  factories.routerFactory
);
