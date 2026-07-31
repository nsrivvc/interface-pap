// Creates the final_core_master_capacity table (schema modeled on
// lh_silver_supplynriskmanagementdev_core_master_capacity) and seeds it with
// sample firm-source rows. Safe to re-run: drops and recreates the table.
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — copy server/.env.example to server/.env first.');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

await sql.query(`DROP TABLE IF EXISTS final_core_master_capacity`);
await sql.query(`
  CREATE TABLE final_core_master_capacity (
    id BIGSERIAL,
    "NGHContractID" TEXT NOT NULL,
    "PipelineDuns" TEXT NOT NULL,
    "PipelineName" TEXT,
    "ContractNumber" TEXT,
    "AwardNumber" TEXT,
    "OfferNumber" TEXT,
    "BidNumber" TEXT,
    "ReleaserContractNumber" TEXT,
    "PostedDate" TIMESTAMP,
    "BeginDate" TIMESTAMP,
    "EndDate" TIMESTAMP,
    "ContractQuantity" TEXT,
    "RateSchedule" TEXT,
    "ContractHolder" TEXT,
    "ContractHolderDuns" TEXT,
    "ReleaserName" TEXT,
    "ReleaserDuns" TEXT,
    "Evergreen" TEXT,
    "NoticePeriodDays" INT,
    "CalculatedEndDate" TIMESTAMP,
    "ReplacementShipperRoleIndicator" TEXT,
    "TermNotes" TEXT,
    "ContractType" TEXT,
    "CreatedDate" TIMESTAMP,
    "UpdateDate" TIMESTAMP,
    "Source" TEXT,
    PRIMARY KEY ("NGHContractID", "PipelineDuns")
  )
`);

const PIPELINES = [
  { name: 'Transcontinental Gas Pipe Line Company, LLC', duns: '001923023' },
  { name: 'Texas Eastern Transmission, LP', duns: '007914151' },
  { name: 'Columbia Gas Transmission, LLC', duns: '004083840' },
  { name: 'Tennessee Gas Pipeline Company, L.L.C.', duns: '006951926' },
  { name: 'ANR Pipeline Company', duns: '006926447' },
  { name: 'Northern Natural Gas Company', duns: '007128646' },
];

const HOLDERS = [
  { name: 'Shell Energy North America (US), L.P.', duns: '832737166' },
  { name: 'BP Energy Company', duns: '929857013' },
  { name: 'ConocoPhillips Company', duns: '129185077' },
  { name: 'Sequent Energy Management, LLC', duns: '011644382' },
  { name: 'Tenaska Marketing Ventures', duns: '878760653' },
  { name: 'Macquarie Energy LLC', duns: '783758424' },
  { name: 'Southwest Energy, L.P.', duns: '054515481' },
];

const RATE_SCHEDULES = ['FTS', 'FT-A', 'FT', 'FTS-1', 'X-2', 'FT-G'];
const TERM_NOTES = [
  null,
  'Seasonal capacity Nov-Mar.',
  'Subject to annual renegotiation of negotiated rate.',
  'Released capacity — recallable on 30 days notice.',
  'Includes primary delivery point flexibility.',
];

const pad = (n, w) => String(n).padStart(w, '0');
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const day = 86400000;

const rows = [];
for (let i = 0; i < 20; i++) {
  const pipeline = PIPELINES[i % PIPELINES.length];
  const holder = HOLDERS[i % HOLDERS.length];
  const isRelease = i % 4 === 0; // every 4th row is a capacity release
  const releaser = isRelease ? HOLDERS[(i + 3) % HOLDERS.length] : null;
  const begin = new Date(Date.parse('2024-04-01T09:00:00Z') + (i % 8) * 45 * day);
  const posted = new Date(begin.getTime() - 30 * day);
  const termYears = 1 + (i % 5);
  const end = new Date(begin.getTime() + termYears * 365 * day);
  const evergreen = i % 3 === 0;
  const noticeDays = evergreen ? [30, 60, 90, 180, 365][i % 5] : null;
  const calcEnd = evergreen ? new Date(end.getTime() + 365 * day) : end;
  const created = new Date(posted.getTime() - 2 * day);

  rows.push({
    NGHContractID: `NGH-FCMC-2024-${pad(i + 1, 4)}`,
    PipelineDuns: pipeline.duns,
    PipelineName: pipeline.name,
    ContractNumber: `K${pad(410250 + i * 17, 6)}`,
    AwardNumber: isRelease ? `AWD-${pad(88100 + i, 5)}` : null,
    OfferNumber: isRelease ? `OFR-${pad(52300 + i, 5)}` : null,
    BidNumber: isRelease ? `BID-${pad(70450 + i, 5)}` : null,
    ReleaserContractNumber: isRelease ? `K${pad(398100 + i * 13, 6)}` : null,
    PostedDate: iso(posted),
    BeginDate: iso(begin),
    EndDate: iso(end),
    ContractQuantity: String(25000 + (i % 10) * 15000),
    RateSchedule: RATE_SCHEDULES[i % RATE_SCHEDULES.length],
    ContractHolder: holder.name,
    ContractHolderDuns: holder.duns,
    ReleaserName: releaser ? releaser.name : null,
    ReleaserDuns: releaser ? releaser.duns : null,
    Evergreen: evergreen ? 'Y' : 'N',
    NoticePeriodDays: noticeDays,
    CalculatedEndDate: iso(calcEnd),
    ReplacementShipperRoleIndicator: isRelease ? 'Y' : 'N',
    TermNotes: TERM_NOTES[i % TERM_NOTES.length],
    ContractType: 'FIRM',
    CreatedDate: iso(created),
    UpdateDate: iso(new Date(created.getTime() + (i % 6) * 10 * day)),
    Source: 'firm',
  });
}

const columns = Object.keys(rows[0]);
const colList = columns.map((c) => `"${c}"`).join(', ');
for (const row of rows) {
  const placeholders = columns.map((_, j) => `$${j + 1}`).join(', ');
  await sql.query(
    `INSERT INTO final_core_master_capacity (${colList}) VALUES (${placeholders})`,
    columns.map((c) => row[c])
  );
}

const [{ count }] = await sql.query(`SELECT count(*)::int AS count FROM final_core_master_capacity`);
console.log(`final_core_master_capacity created with ${count} rows (Source = 'firm').`);
