import Header from '../components/Header';
import WorkflowPanel from '../components/WorkflowPanel';

export default function Dashboard() {
  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Data Pipeline Interface</div>
          <h1>Contract Workflow Dashboard</h1>
          <p>
            Configure workflows from the pipeline stages, trigger individual pipelines
            manually, and schedule automatic daily runs.
          </p>
        </div>
      </div>

      <div className="page">
        <WorkflowPanel />
      </div>
    </>
  );
}
