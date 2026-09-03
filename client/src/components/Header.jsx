// Top navigation bar: the tabs this account can reach, who is signed in with
// which role, and log out. Which tabs appear comes from NAV in accounts.js —
// the same capability list App uses to gate the routes themselves.
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { NAV, ROLE_BLURB, ROLE_LABEL, can, homePath, roleOf } from '../accounts';

export default function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <Link to={homePath(user)} className="logo">
        <span className="logo-mark">
          V<span>C</span>
        </span>
        Pipeline Accelerator Program
      </Link>
      <nav className="header-nav">
        {NAV.filter((tab) => can(user, tab.capability)).map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <div className="header-user">
        <span>
          Signed in as <strong>{user?.name}</strong>
        </span>
        <span className={`role-badge role-${roleOf(user)}`} title={ROLE_BLURB[roleOf(user)]}>
          {ROLE_LABEL[roleOf(user)]}
        </span>
        <button className="btn btn-outline" onClick={logout}>
          Log Out
        </button>
      </div>
    </header>
  );
}
