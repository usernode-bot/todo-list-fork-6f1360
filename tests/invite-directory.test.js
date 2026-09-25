// The invite path's one-way door: an unanswered directory lookup must never be
// read as "this user does not exist".
//
// Invites are validated against the PLATFORM user directory (issue #50). Every
// way that lookup can fail — no platform URL, no forwarded token, a timeout, a
// 429, a 5xx — has to degrade OPEN and accept the handle as typed. Get that
// backwards and the failure is invisible in staging (where the directory is
// reachable and every check passes) while production locks people out of
// inviting anyone at all. No screenshot check can see it, so it is pinned here.
//
// server.js opens a Postgres pool and listens on import, so it is asserted as
// source text — the same approach tests/sw-offline.test.js takes with
// public/index.html.
//
// Run with: node --test tests/invite-directory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The body of POST /api/lists/:id/members.
function membersPostBody() {
  const start = SERVER.indexOf("app.post('/api/lists/:id/members'");
  assert.notEqual(start, -1, 'POST /api/lists/:id/members should exist');
  const end = SERVER.indexOf("app.delete('/api/lists/:id/members/:memberId'", start);
  assert.notEqual(end, -1, 'the DELETE members route should follow the POST');
  return SERVER.slice(start, end);
}

test('the app token header is conditional on the app token existing', () => {
  // Staging containers get USERNODE_PLATFORM_API_URL but NOT the app token —
  // /users/* is the one place the platform authenticates on the user token
  // alone. Sending an undefined app-token header there breaks every staging
  // preview's typeahead.
  assert.match(
    SERVER,
    /if \(PLATFORM_APP_TOKEN\) headers\['x-usernode-app-token'\] = PLATFORM_APP_TOKEN;/,
    'x-usernode-app-token must only be set when the token is present'
  );
  // The user token, by contrast, is always sent.
  assert.match(
    SERVER,
    /'x-usernode-user-token': rawUserToken\(req\)/,
    'the forwarded user token must always be sent'
  );
  // Never branch this on the environment: the presence of the value is the
  // only correct signal.
  const headers = SERVER.slice(
    SERVER.indexOf('function directoryHeaders'),
    SERVER.indexOf('async function directoryGet')
  );
  assert.doesNotMatch(headers, /IS_STAGING|USERNODE_ENV/,
    'the directory headers must not be gated on the environment');
});

test('directoryGet reports every failure as unanswered rather than throwing', () => {
  const fn = SERVER.slice(
    SERVER.indexOf('async function directoryGet'),
    SERVER.indexOf('const DIRECTORY_SEARCH_TIMEOUT_MS')
  );
  assert.match(fn, /if \(!PLATFORM_API_URL\) return \{ ok: false \};/,
    'a missing platform URL is an unanswered question');
  assert.match(fn, /if \(!userToken\) return \{ ok: false \};/,
    'a missing user token is an unanswered question');
  assert.match(fn, /if \(!resp\.ok\) return \{ ok: false \};/,
    'a non-2xx (429 included) is an unanswered question');
  assert.match(fn, /catch \([^)]*\) \{\s*return \{ ok: false \};/,
    'a thrown fetch/parse/abort is an unanswered question, not an exception');
  assert.match(fn, /signal: ctl\.signal/,
    'directory calls need a deadline so a slow platform cannot hang an invite');
});

test('only an explicit found === false rejects an invite', () => {
  const body = membersPostBody();
  assert.match(body, /hit\.data\.found === false/,
    'the 422 must be reached from an explicit found === false');
  // The rejection has to sit behind BOTH "we got an answer" and "the answer
  // was no".
  assert.match(
    body,
    /const answered = hit\.ok && typeof hit\.data\.found === 'boolean';/,
    'the handler must decide whether the lookup answered at all'
  );
  assert.match(body, /if \(answered && hit\.data\.found === false\)/,
    'the 422 must require an answered lookup');
  // The regression this guards: a falsy check treats "couldn't ask" as "no
  // such user" and refuses every invite whenever the directory is unreachable.
  assert.doesNotMatch(body, /if \(!\s*hit\.ok\)\s*return res\.status\(42/,
    'a failed lookup must not reject the invite');
  assert.doesNotMatch(body, /if \(![a-zA-Z.]*found\)\s*\{?\s*return res\.status\(422/,
    'a falsy `found` check would reject on an unanswered lookup');
  // And the degrade-open fallback: the typed handle is used when there is no
  // canonical spelling to use instead.
  assert.match(body, /\|\| username;/,
    'an unanswered lookup must fall back to the handle as typed');
  assert.match(body, /unverified: !answered/,
    'the reply must admit when the name could not be checked');
});

test('the invite never writes user_id from the directory', () => {
  const body = membersPostBody();
  // getListRole grants access on list_members.user_id, so a wrong id there
  // hands the list to the wrong account. The username match backfills it
  // correctly on the invitee's first visit.
  assert.match(body, /INSERT INTO list_members \(list_id, username\) VALUES \(\$1, \$2\)/,
    'members are inserted by username only');
  assert.doesNotMatch(body, /user\.id/,
    "the directory's user id must not be written to list_members");
});

test('the app-seen roster is gone, not merely unused', () => {
  // Validating invites against "people who have opened this app" is exactly the
  // approximation the platform tells apps not to build, and it rejected every
  // real account that had not used Todo List yet.
  const mentions = SERVER.match(/known_users/g) || [];
  const dropped = /DROP TABLE IF EXISTS known_users;/.test(SERVER);
  assert.ok(dropped, 'the migration should drop the table');
  assert.doesNotMatch(SERVER, /INSERT INTO known_users|FROM known_users/,
    'nothing may read or write the roster');
  assert.ok(mentions.length <= 2,
    `known_users should only survive in the DROP and its comment (found ${mentions.length})`);
  assert.doesNotMatch(SERVER, /rememberUser/,
    'the auth-path write that fed the roster should be gone');
});

test('the suggestion route answers "could not ask" distinctly from "nobody"', () => {
  const route = SERVER.slice(
    SERVER.indexOf("app.get('/api/lists/:id/member-suggestions'"),
    SERVER.indexOf("app.post('/api/lists/:id/members'")
  );
  assert.match(route, /if \(!hit\.ok\)/, 'a failed search must be handled');
  assert.match(route, /unavailable: true/,
    'a failed search must be reported as unavailable, not as an empty result');
  assert.doesNotMatch(route, /if \(!hit\.ok\)[\s\S]{0,200}status\(5/,
    'a failed search must not 500 — the client degrades open on it');
  // exists is computed before the owner/member filter, so the box can say
  // "already on this list" rather than "no such user".
  const existsAt = route.indexOf('const exists =');
  const filterAt = route.indexOf('const usernames = names.filter');
  assert.ok(existsAt !== -1 && filterAt !== -1 && existsAt < filterAt,
    'exists must be computed before the owner/member filter');
  assert.match(route, /q\.length < 2/,
    'a 1-character prefix must not be sent to the directory');
});

test('the client only disables Invite on an answered lookup', () => {
  const apply = INDEX.slice(
    INDEX.indexOf('function applyInviteResult'),
    INDEX.indexOf('function setInviteNote')
  );
  // Order matters: unavailable and filtered are handled and returned BEFORE
  // anything can block, so a lookup that could not run never disables Invite.
  const unavailableAt = apply.indexOf('if (result.unavailable)');
  const clearAt = apply.indexOf('if (result.exists || result.hasMore)');
  const blockAt = apply.indexOf('setInviteBlocked(true)');
  assert.ok(unavailableAt !== -1 && clearAt !== -1 && blockAt !== -1,
    'the branches should all be present');
  assert.ok(unavailableAt < clearAt && clearAt < blockAt,
    'the unavailable and match branches must short-circuit before the block');
  assert.match(apply, /if \(result\.unavailable\)[\s\S]{0,200}setInviteBlocked\(false\)/,
    'an unavailable lookup must leave the Invite button enabled');
  // hasMore guards a truncated prefix window: the exact match may simply be
  // off the end of the result set.
  assert.match(apply, /result\.exists \|\| result\.hasMore/,
    'a truncated result set must not be read as "no such user"');
  // Exactly one setInviteBlocked(true) in the function — refusal has one door.
  assert.equal((apply.match(/setInviteBlocked\(true\)/g) || []).length, 1,
    'there should be a single path that disables the Invite button');
  // And it must not claim nobody matches while matches are on screen.
  assert.match(apply, /inviteHits\.length[\s\S]{0,120}No one on Usernode matches/,
    'the "no one matches" copy must be conditional on there being no matches shown');
});

test('the client falls back from the bridge to the server, then degrades open', () => {
  const fetchFn = INDEX.slice(
    INDEX.indexOf('async function fetchInviteSuggestions'),
    INDEX.indexOf('function applyInviteResult')
  );
  assert.match(fetchFn, /inviteSearchViaBridge\(q\)/, 'the bridge is tier one');
  assert.match(fetchFn, /inviteSearchViaServer\(q\)/, 'the server route is tier two');
  assert.match(fetchFn, /if \(!result\) result = INVITE_UNAVAILABLE;/,
    'both tiers failing degrades open, it does not block');
  // The bridge rejects outside the platform shell by design — that is a
  // "couldn't ask", so it must be caught rather than surfaced.
  const bridge = INDEX.slice(
    INDEX.indexOf('async function inviteSearchViaBridge'),
    INDEX.indexOf('async function inviteSearchViaServer')
  );
  assert.match(bridge, /catch \([^)]*\) \{\s*return null;/,
    'a bridge rejection outside the shell must not surface as an error');
});
