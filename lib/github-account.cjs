// Pure helpers for the "check the organisation name before you go to GitHub"
// step in the setup wizard. Kept out of main.js so they can be tested without
// Electron: the name rules are exactly the kind of thing that breaks silently.

/**
 * Normalise whatever someone realistically types or pastes into a bare GitHub
 * account name: a name, an @name, or a full github.com URL (with or without a
 * trailing path).
 * Returns '' when there's nothing usable.
 */
function normaliseAccountName(input) {
  return String(input == null ? '' : input)
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}

/**
 * GitHub's own rule for account names: alphanumerics, single inner hyphens,
 * 39 characters max, no leading or trailing hyphen.
 */
function isValidAccountName(name) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(String(name || ''));
}

/**
 * Turn a GitHub /users/:name response into the ruling the wizard shows. Only
 * an Organization can hold a brain, because GitHub does not let an app create
 * a repository on a personal account.
 * @param {number} status HTTP status from the GitHub call
 * @param {object|null} body parsed JSON body, when there was one
 * @param {string} name the normalised name that was looked up
 */
function classifyAccount(status, body, name) {
  if (status === 404) return { ok: false, reason: 'not-found', login: name };
  if (status === 403 || status === 429) return { ok: false, reason: 'rate-limited', login: name };
  if (status < 200 || status >= 300) {
    return { ok: false, reason: 'lookup-failed', login: name, detail: `HTTP ${status}` };
  }
  const isOrg = !!body && body.type === 'Organization';
  return {
    ok: isOrg,
    reason: isOrg ? 'org' : 'personal-account',
    login: (body && body.login) || name,
    id: body && body.id,
    type: (body && body.type) || 'User',
  };
}

module.exports = { normaliseAccountName, isValidAccountName, classifyAccount };
