// Verifies the Power BI service-principal auth chain end to end:
//   env vars -> Azure AD client-credentials token -> Power BI REST API ->
//   workspace visibility. Run with:  node scripts/test-powerbi-auth.js
// Never prints the token or the client secret.
import 'dotenv/config';

const KEYS = [
  'POWERBI_TENANT_ID',
  'POWERBI_CLIENT_ID',
  'POWERBI_CLIENT_SECRET',
  'POWERBI_WORKSPACE_ID',
];

const results = []; // [stage, pass, detail]
const record = (stage, pass, detail = '') => {
  results.push([stage, pass, detail]);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${stage}${detail ? ` — ${detail}` : ''}`);
};

function summarize() {
  console.log('\n———— Summary ————');
  for (const [stage, pass, detail] of results) {
    console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'}  ${stage}${detail ? ` — ${detail}` : ''}`);
  }
  process.exit(results.every(([, p]) => p) ? 0 : 1);
}

// ---------- Stage 1: env vars ----------
let envOk = true;
for (const key of KEYS) {
  const raw = process.env[key];
  if (!raw) {
    console.log(`FAIL  env: ${key} is missing or empty`);
    envOk = false;
    continue;
  }
  const problems = [];
  if (raw !== raw.trim()) problems.push('has leading/trailing whitespace');
  if (/^["']|["']$/.test(raw.trim())) problems.push('is wrapped in quotes');
  if (/\s/.test(raw.trim()) && key !== 'POWERBI_CLIENT_SECRET')
    problems.push('contains internal whitespace');
  if (
    ['POWERBI_TENANT_ID', 'POWERBI_CLIENT_ID', 'POWERBI_WORKSPACE_ID'].includes(key) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim())
  )
    problems.push('does not look like a GUID');
  if (problems.length) {
    console.log(`FAIL  env: ${key} ${problems.join('; ')}`);
    envOk = false;
  }
}
record('env vars present and clean', envOk);
if (!envOk) {
  console.log('\nFix server/.env first: one KEY=value per line, no quotes, no stray spaces.');
  summarize();
}

const { POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET, POWERBI_WORKSPACE_ID } =
  process.env;

// Redact any accidental secret occurrence before logging a response body
const safe = (text) => String(text).replaceAll(POWERBI_CLIENT_SECRET, '<CLIENT_SECRET REDACTED>');

// ---------- Stage 2: Azure AD token ----------
let token = null;
try {
  const resp = await fetch(
    `https://login.microsoftonline.com/${POWERBI_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: POWERBI_CLIENT_ID,
        client_secret: POWERBI_CLIENT_SECRET,
        scope: 'https://analysis.windows.net/powerbi/api/.default',
      }),
    }
  );
  const body = await resp.text();
  if (!resp.ok) {
    record('Azure AD client-credentials token', false, `HTTP ${resp.status}`);
    console.log('  Response body:', safe(body));
    summarize();
  }
  token = JSON.parse(body).access_token;
  record('Azure AD client-credentials token', Boolean(token), token ? 'token received' : 'no access_token in response');
  if (!token) summarize();
} catch (err) {
  record('Azure AD client-credentials token', false, safe(err.message));
  summarize();
}

// ---------- Stage 3: Power BI API — list workspaces ----------
let groups = null;
try {
  const resp = await fetch('https://api.powerbi.com/v1.0/myorg/groups', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.text();
  if (!resp.ok) {
    record('Power BI API GET /groups', false, `HTTP ${resp.status}`);
    console.log('  Response body:', safe(body));
    summarize();
  }
  groups = JSON.parse(body).value || [];
  record('Power BI API GET /groups', true, `${groups.length} workspace(s) visible`);
  for (const g of groups) console.log(`        • ${g.name}  (${g.id})`);
  if (!groups.length)
    console.log(
      '        (none visible — is the service principal a Member/Admin of the workspace,\n' +
        '         and is "Service principals can use Fabric APIs" enabled for its security group?)'
    );
} catch (err) {
  record('Power BI API GET /groups', false, safe(err.message));
  summarize();
}

// ---------- Stage 4: target workspace visible ----------
const target = groups.find((g) => g.id.toLowerCase() === POWERBI_WORKSPACE_ID.toLowerCase());
record(
  'POWERBI_WORKSPACE_ID found in list',
  Boolean(target),
  target ? `"${target.name}"` : `no workspace with id ${POWERBI_WORKSPACE_ID}`
);

summarize();
