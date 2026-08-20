import Header from '../components/Header';

// Power BI embed target. Two ways to fill this in, in order of effort:
//   1. Secure embed (quickest): open the report on app.powerbi.com, then
//      File -> Embed report -> Website or portal, and paste the iframe URL into
//      client/.env as VITE_POWERBI_EMBED_URL. Viewers must be signed in to
//      Power BI in the same browser.
//   2. App-owns-data (seamless, no Power BI login for viewers): register an
//      Azure AD app + service principal, mint embed tokens on the server, and
//      swap the <iframe> below for <PowerBIEmbed> from powerbi-client-react
//      (already installed).
const EMBED_URL = import.meta.env.VITE_POWERBI_EMBED_URL || '';

export default function Reports() {
  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Analytics</div>
          <h1>Power BI Reports</h1>
          <p>Dashboards built on the pipeline&apos;s master capacity tables in Neon.</p>
        </div>
      </div>

      <div className="page">
        {EMBED_URL ? (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <iframe
              title="Power BI report"
              src={EMBED_URL}
              style={{ width: '100%', height: 640, border: 0, display: 'block' }}
              allowFullScreen
            />
          </div>
        ) : (
          <div className="card">
            <h3>No report connected yet</h3>
            <p className="muted" style={{ marginTop: 8 }}>
              To connect one: build a report in Power BI Desktop against the Neon Postgres
              database (PostgreSQL connector), publish it to the Power BI service, then choose
              File &rarr; Embed report &rarr; Website or portal and paste the iframe URL into{' '}
              <code>client/.env</code> as <code>VITE_POWERBI_EMBED_URL</code>. Restart the dev
              server and the report will render here.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
