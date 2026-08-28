// Top navigation bar: the four tabs, who is signed in, and log out.
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth-context';

export default function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <Link to="/" className="logo">
        <span className="logo-mark">
          V<span>C</span>
        </span>
        Pipeline Accelerator Program
      </Link>
      <nav className="header-nav">
        <NavLink to="/reference">Reference Data</NavLink>
        <NavLink to="/" end>
          Contract Workflow Dashboard
        </NavLink>
        <NavLink to="/tables">Table Viewer</NavLink>
        <NavLink to="/reports">Reports</NavLink>
      </nav>
      <div className="header-user">
        <span>
          Signed in as <strong>{user?.name}</strong>
        </span>
        <button className="btn btn-outline" onClick={logout}>
          Log Out
        </button>
      </div>
    </header>
  );
}
