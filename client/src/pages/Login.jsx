// Sign-in form. The local admin (admin / 12345) always works; real accounts
// live in Neon.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <span className="logo-mark">
          V<span style={{ color: '#c05a1e' }}>C</span> Value Creed
        </span>
        <h1>Pipeline Capacity Accelerator Program</h1>
        <p>
          Sign in to access the data pipeline interface — retrieve source data, run
          staged transformations, and orchestrate scheduled workflows, all backed by
          a single Neon database.
        </p>
      </div>
      <div className="auth-form-side">
        <form className="auth-card" onSubmit={submit}>
          <h2>Welcome back</h2>
          <p className="muted">Sign in to your account</p>
          {error && <div className="auth-error">{error}</div>}
          <div className="field">
            <label>Email or username</label>
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn btn-orange" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
          <p className="auth-switch">
            No account yet? <Link to="/register">Create one</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
