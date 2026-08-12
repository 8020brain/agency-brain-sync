// The words the setup wizard says when the GitHub organisation someone named
// already holds another brain from the same agency. Kept out of main.js and out
// of the renderer so the wording can be tested without Electron, and so the
// pre-GitHub warning and the after-the-fact one can never drift apart.
//
// This is a WARNING and nothing here refuses anything. Several clients in one
// organisation works, and the brains stay separate: a client added as an
// outside collaborator on their own repository cannot read the others.
//
// What it costs is handover. The two-minute handover invites the brain's owner
// into the ORGANISATION as an owner, and a GitHub organisation owner can read
// every repository in it, so from a shared organisation that would hand them
// everyone else's brain. Handover from a shared organisation is a repository
// transfer instead, which is about an hour's work.
// (brain: projects/clientbrain/reference/handover-runbook.md)
//
// The server decides whether the other brains may be NAMED — a client owner
// running their own setup gets the count and no names, because our warning must
// not tell them who else the agency works for. So an empty `clients` list here
// is normal, not a bug.

/** "A", "A and B", "A, B and C" — plain prose, never a bare comma list. */
function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Turn the server's finding into the panel's heading and paragraphs.
 * @param {{org: string, count: number, clients: Array<{slug: string, name: string}>}|null} shared
 * @param {'before'|'after'} mode 'before' while they can still pick another
 *   organisation, 'after' once the brain has already been created in this one.
 * @returns {{heading: string, body: string[]}|null} null when there's nothing to say.
 */
function describeSharedOrg(shared, mode) {
  if (!shared || !shared.count) return null;
  const org = String(shared.org || 'that organisation');
  const count = Number(shared.count) || 0;
  const names = Array.isArray(shared.clients) ? shared.clients.map((c) => c && c.name).filter(Boolean) : [];

  const heading = count === 1
    ? `${org} already holds another AI brain.`
    : `${org} already holds ${count} other AI brains.`;

  let opener;
  if (names.length === 1) {
    opener = `That one belongs to ${names[0]}. `;
  } else if (names.length > 1) {
    opener = `They belong to ${joinNames(names)}. `;
  } else {
    opener = '';
  }

  const body = [
    `${opener}You can put this brain there too, and they stay separate: nobody can read a repository they haven't been added to.`,
    `The cost comes later. When a brain lives in an organisation of its own, handing it to its owner takes two minutes, because you invite them as an organisation owner and step out. That doesn't work in a shared organisation, since an organisation owner can read every repository in it. Handover here means transferring the repository across instead, which works and takes about an hour.`,
    mode === 'after'
      ? `Nothing is wrong, and there's nothing to do now. It's worth knowing for the day this brain gets handed over, because that's a repository transfer rather than the two-minute invite.`
      : `Organisations are free and GitHub publishes no limit on how many you can have, so a new one for this brain costs nothing.`,
  ];

  return { heading, body };
}

module.exports = { joinNames, describeSharedOrg };
