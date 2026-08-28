import Header from '../components/Header';
import ComponentsConfig from '../components/ComponentsConfig';

// Reference Data — the warehouse tables the pipelines rely on, moved out of
// the workflow form into their own tab. Shared by every workflow.
export default function ReferenceData() {
  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Data Pipeline Interface</div>
          <h1>Reference Data</h1>
          <p>
            The source API and the warehouse tables every workflow relies on — pipelines,
            shippers, locations and rec-del pairings — maintained in one place.
          </p>
        </div>
      </div>

      <div className="page">
        <div className="panel">
          <ComponentsConfig />
        </div>
      </div>
    </>
  );
}
