// Accounts — the admin-only tab for who can get in and what they can do.
//
// Three blocks, in the order an admin needs them:
//   1. the role key       — what Admin and Viewer each cover, straight from
//                           the capability list in accounts.js
//   2. the accounts list  — every account, with its role editable in place
//   3. add an account     — create someone directly with the role they need
//
// Public sign-ups land here as Viewers; promoting one is the role dropdown.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import Header from '../components/Header';
import { useAuth } from '../auth-context';
import {
  CAPABILITIES,
  DEFAULT_ROLE,
  ROLES,
  ROLE_BLURB,
  ROLE_LABEL,
  capabilitiesOf,
} from '../accounts';

const EMPTY_DRAFT = { name: '', email: '', password: '', role: DEFAULT_ROLE };

export default function Accounts() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null); // account whose role is saving
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api('/api/accounts')
      .then((d) => {
        setAccounts(d.accounts);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const changeRole = async (account, role) => {
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      await api(`/api/accounts/${account.id}/role`, { method: 'PUT', body: { role } });
      setNotice(`${account.name} is now ${ROLE_LABEL[role]}.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (account) => {
    if (!window.confirm(`Remove ${account.name}? They lose access immediately.`)) return;
    setBusyId(account.id);
    setError('');
    setNotice('');
    try {
      await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
      setNotice(`${account.name} was removed.`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    setNotice('');
    try {
      const { account } = await api('/api/accounts', { method: 'POST', body: draft });
      setNotice(`Created ${account.name} as ${ROLE_LABEL[account.role]}.`);
      setDraft(EMPTY_DRAFT);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <Header />
      <div className="hero-band">
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="eyebrow">Access Control</div>
          <h1>Accounts</h1>
          <p>
            Who can sign in, and what each of them can do. Anyone who signs up on their own
            starts as a read-only Viewer — promote them here when they need more.
          </p>
        </div>
      </div>

      <div className="page">
        <div className="panel">
          {/* 1. What the two roles mean */}
          <div className="wf-group-head" style={{ marginTop: 0 }}>
            <strong>Roles</strong>
            <span className="muted">what each kind of account can reach</span>
          </div>
          <div className="acct-matrix">
            <table>
              <thead>
                <tr>
                  <th>Can</th>
                  {ROLES.map((role) => (
                    <th key={role} className="acct-matrix-role">
                      <span className={`role-badge role-${role}`}>{ROLE_LABEL[role]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(CAPABILITIES).map(([key, label]) => (
                  <tr key={key}>
                    <td>{label}</td>
                    {ROLES.map((role) => (
                      <td key={role} className="acct-matrix-cell">
                        {capabilitiesOf(role).includes(key) ? (
                          <span className="acct-yes">✓</span>
                        ) : (
                          <span className="acct-no">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error && <div className="status-line err">{error}</div>}
          {notice && <div className="status-line ok">{notice}</div>}

          {/* 2. Everyone with an account */}
          <div className="wf-group-head">
            <strong>Accounts</strong>
            <span className="muted">change a role with the dropdown — it saves immediately</span>
          </div>
          {!accounts && !error && <p className="muted cc-loading">Loading accounts…</p>}
          {accounts && (
            <div className="acct-table">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const self = account.id === user?.id;
                    const locked = account.builtIn || self; // own role and the built-in admin stay put
                    return (
                      <tr key={account.id}>
                        <td>
                          <strong>{account.name}</strong>
                          {self && <span className="acct-tag">you</span>}
                          {account.builtIn && <span className="acct-tag">built-in</span>}
                        </td>
                        <td className="muted">{account.email}</td>
                        <td>
                          {locked ? (
                            <span className={`role-badge role-${account.role}`}>
                              {ROLE_LABEL[account.role]}
                            </span>
                          ) : (
                            <select
                              className="acct-role-select"
                              value={account.role}
                              disabled={busyId === account.id}
                              onChange={(e) => changeRole(account, e.target.value)}
                              title={ROLE_BLURB[account.role]}
                            >
                              {ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABEL[role]}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="muted">
                          {account.createdAt
                            ? new Date(account.createdAt).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="acct-actions">
                          {!locked && (
                            <button
                              type="button"
                              className="cc-remove"
                              title="Remove this account"
                              disabled={busyId === account.id}
                              onClick={() => remove(account)}
                            >
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 3. Create one directly, with the role it should have */}
          <div className="wf-group-head">
            <strong>Add an account</strong>
            <span className="muted">creates the login straight away — no sign-up needed</span>
          </div>
          <form className="acct-new" onSubmit={create}>
            <div className="field">
              <label>Full name</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label>Password (min 8 characters)</label>
              <input
                type="password"
                value={draft.password}
                onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                minLength={8}
                required
              />
            </div>
            <div className="field">
              <label>Role</label>
              <select
                className="acct-role-select"
                value={draft.role}
                onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABEL[role]}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-navy" disabled={creating}>
              {creating ? '⟳ Creating…' : '+ Create Account'}
            </button>
          </form>
          <p className="wf-note">{ROLE_BLURB[draft.role]}</p>
        </div>
      </div>
    </>
  );
}
