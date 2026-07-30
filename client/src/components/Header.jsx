import { Link } from 'react-router-dom';
import { useAuth } from '../auth-context';

export default function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <Link to="/" className="logo">
        <span className="logo-mark">
          V<span>C</span>
        </span>
        Value Creed
      </Link>
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
