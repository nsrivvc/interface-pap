// The route table. Every page except login/register sits behind <Protected>,
// which bounces signed-out visitors to /login and sends signed-in ones away
// from pages their role can't open — a Viewer typing /reference lands on the
// Table Viewer instead. The capability names match NAV in accounts.js, so a
// tab the header hides is also a URL nobody can reach by hand.
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth-context';
import { can, homePath } from './accounts';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import ReferenceData from './pages/ReferenceData';
import TableViewer from './pages/TableViewer';
import TableView from './pages/TableView';
import Reports from './pages/Reports';
import Accounts from './pages/Accounts';

function Protected({ capability, children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (capability && !can(user, capability)) return <Navigate to={homePath(user)} replace />;
  return children;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homePath(user)} replace /> : <Login />} />
      <Route
        path="/register"
        element={user ? <Navigate to={homePath(user)} replace /> : <Register />}
      />
      <Route
        path="/"
        element={
          <Protected capability="dashboard">
            <Dashboard />
          </Protected>
        }
      />
      <Route
        path="/reference"
        element={
          <Protected capability="reference">
            <ReferenceData />
          </Protected>
        }
      />
      <Route
        path="/tables"
        element={
          <Protected capability="tables">
            <TableViewer />
          </Protected>
        }
      />
      <Route
        path="/tables/:name"
        element={
          <Protected capability="tables">
            <TableView />
          </Protected>
        }
      />
      <Route
        path="/reports"
        element={
          <Protected capability="reports">
            <Reports />
          </Protected>
        }
      />
      <Route
        path="/accounts"
        element={
          <Protected capability="accounts">
            <Accounts />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
