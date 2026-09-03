// Contract Workflow Dashboard page shell: hero banner + the WorkflowPanel,
// which holds the scenarios and workflows UI.
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
            Create scenarios, attach them to workflows, run them on demand, and
            schedule automatic daily runs.
          </p>
        </div>
      </div>

      <div className="page">
        <WorkflowPanel />
      </div>
    </>
  );
}
