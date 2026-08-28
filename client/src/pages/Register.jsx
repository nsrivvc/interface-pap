// Account creation form — name, email, password (stored hashed in Neon).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth-context';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await register(name, email, password);
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
        <h1>Future-Ready CTRM Excellence</h1>
        <p>
          Create an account to access the pipeline dashboard — staged data
          transformations and workflow orchestration in one place.
        </p>
      </div>
      <div className="auth-form-side">
        <form className="auth-card" onSubmit={submit}>
          <h2>Create your account</h2>
          <p className="muted">It only takes a minute</p>
          {error && <div className="auth-error">{error}</div>}
          <div className="field">
            <label>Full Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label>Password (min 8 characters)</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <button className="btn btn-orange" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Creating…' : 'Create Account'}
          </button>
          <p className="auth-switch">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
