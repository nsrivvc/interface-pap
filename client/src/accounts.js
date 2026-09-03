// Roles in the UI — the client-side half of server/src/accounts.js.
//
// The server is what actually enforces access (requireAdmin on every write
// route); this file decides what the interface SHOWS, so a viewer never meets a
// button that would only answer 403. Both halves name the same two roles:
//
//   admin  — everything
//   viewer — the Table Viewer and its downloads, read-only
//
// Adding a capability: add it to CAPABILITIES, list it under the roles that
// get it, and gate the UI with can(user, 'thatCapability').

export const ROLES = ['admin', 'viewer'];
export const DEFAULT_ROLE = 'viewer';

export const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer' };
export const ROLE_BLURB = {
  admin: 'Full access — reference data, scenarios, workflows, reports and accounts.',
  viewer: 'Read-only — browse the Table Viewer and download tables.',
};

// Every gate the UI knows about, and what it covers
export const CAPABILITIES = {
  tables: 'Browse the Table Viewer and download tables',
  reference: 'Edit reference data and the source API configuration',
  dashboard: 'Run workflows, trigger pipelines and manage scenarios',
  reports: 'Generate Power BI reports',
  accounts: 'Create accounts and change their roles',
};

const ROLE_CAPABILITIES = {
  admin: Object.keys(CAPABILITIES),
  viewer: ['tables'],
};

/** The capability keys one role holds — drives the Accounts page matrix. */
export const capabilitiesOf = (role) => ROLE_CAPABILITIES[role] || [];

export const roleOf = (user) => (ROLES.includes(user?.role) ? user.role : DEFAULT_ROLE);

/** Can this account do `capability`? Signed-out accounts can do nothing. */
export function can(user, capability) {
  if (!user) return false;
  return ROLE_CAPABILITIES[roleOf(user)].includes(capability);
}

export const isAdmin = (user) => roleOf(user) === 'admin';

// The top-nav tabs, in order, each with the capability that reveals it. Header
// renders this list; App gates the matching routes with the same capability, so
// a hidden tab is also an unreachable URL.
export const NAV = [
  { to: '/reference', label: 'Reference Data', capability: 'reference' },
  { to: '/', label: 'Contract Workflow Dashboard', capability: 'dashboard', end: true },
  { to: '/tables', label: 'Table Viewer', capability: 'tables' },
  { to: '/reports', label: 'Reports', capability: 'reports' },
  { to: '/accounts', label: 'Accounts', capability: 'accounts' },
];

/** Where an account lands after signing in — its first visible tab. */
export const homePath = (user) => NAV.find((t) => can(user, t.capability))?.to || '/tables';
