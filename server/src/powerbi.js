// Power BI service-principal auth for the embedded quick-create flow.
//
// quickCreate (client side) needs a raw Azure AD access token — not an embed
// token — so this module just runs the client-credentials flow and caches the
// result until shortly before expiry. Verified end to end by
// scripts/test-powerbi-auth.js.
import 'dotenv/config';

const { POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET, POWERBI_WORKSPACE_ID } =
  process.env;

export const powerbiConfigured = Boolean(
  POWERBI_TENANT_ID && POWERBI_CLIENT_ID && POWERBI_CLIENT_SECRET && POWERBI_WORKSPACE_ID
);

let cached = null; // { accessToken, expiresAt }

export async function powerbiAadToken() {
  if (!powerbiConfigured) {
    throw new Error(
      'Power BI is not configured — set POWERBI_TENANT_ID / POWERBI_CLIENT_ID / ' +
        'POWERBI_CLIENT_SECRET / POWERBI_WORKSPACE_ID in server/.env.'
    );
  }
  // Reuse the token until 2 minutes before it expires (they last ~60-90 min)
  if (cached && Date.now() < cached.expiresAt - 2 * 60_000) return cached;

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
  if (!resp.ok) {
    // Azure error bodies are safe to surface (no secrets) and name the cause,
    // e.g. AADSTS7000222 expired client secret.
    const detail = await resp.text().catch(() => '');
    throw new Error(`Azure AD token request failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const body = await resp.json();
  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return cached;
}

const API = 'https://api.powerbi.com/v1.0/myorg';

async function pbiFetch(path, { method = 'GET', body } = {}) {
  const { accessToken } = await powerbiAadToken();
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Power BI ${method} ${path} failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return resp.status === 204 ? null : resp.json().catch(() => null);
}

/**
 * Create-or-refresh the push dataset holding one gold view, fill it with the
 * given rows, and return an embed token for a report-CREATION canvas on it.
 * The dataset is reused per model name, so reports the user saved against it
 * keep working — rows are simply replaced on the next generate.
 */
export async function goldReportEmbed({ modelName, columns, rows }) {
  const ws = POWERBI_WORKSPACE_ID;
  const table = { name: 'Table', columns };

  const existing = (await pbiFetch(`/groups/${ws}/datasets`)).value.find(
    (d) => d.name === modelName
  );
  let datasetId = existing?.id;
  if (datasetId) {
    try {
      // replace schema (harmless when unchanged) and clear old rows
      await pbiFetch(`/groups/${ws}/datasets/${datasetId}/tables/Table`, {
        method: 'PUT',
        body: table,
      });
      await pbiFetch(`/groups/${ws}/datasets/${datasetId}/tables/Table/rows`, {
        method: 'DELETE',
      });
    } catch {
      await pbiFetch(`/groups/${ws}/datasets/${datasetId}`, { method: 'DELETE' });
      datasetId = null;
    }
  }
  if (!datasetId) {
    const created = await pbiFetch(`/groups/${ws}/datasets?defaultRetentionPolicy=None`, {
      method: 'POST',
      body: { name: modelName, defaultMode: 'Push', tables: [table] },
    });
    datasetId = created.id;
  }

  if (rows.length) {
    await pbiFetch(`/groups/${ws}/datasets/${datasetId}/tables/Table/rows`, {
      method: 'POST',
      body: { rows },
    });
  }

  // V2 GenerateToken (dataset + save target); fall back to the older
  // workspace-scoped Create token if this tenant rejects the V2 shape.
  let token;
  try {
    token = await pbiFetch('/GenerateToken', {
      method: 'POST',
      body: { datasets: [{ id: datasetId }], targetWorkspaces: [{ id: ws }] },
    });
  } catch {
    token = await pbiFetch(`/groups/${ws}/reports/GenerateToken`, {
      method: 'POST',
      body: { accessLevel: 'Create', datasetId, allowSaveAs: true },
    });
  }
  return { datasetId, embedToken: token.token, embedUrl: 'https://app.powerbi.com/reportEmbed' };
}
