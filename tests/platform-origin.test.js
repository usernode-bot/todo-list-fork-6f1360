// Where the app gets the platform's three hosted files, and why it is neither
// of the two obvious answers.
//
// This has now failed twice, in opposite directions:
//
//   1. A hardcoded platform HOSTNAME. The platform moved domains, the old host
//      stopped answering, and the app lost Tailwind, the usernode-native kit
//      and the bridge at once — and with the bridge gone the shell cannot ask
//      whether a service worker is controlling the document, so the app stopped
//      opening offline too.
//   2. A RELATIVE path. Platform PR #2039 serves those three prefixes from each
//      app's own origin, which looks like the fix and removes the hostname
//      entirely. But that routing is best-effort platform infrastructure: when
//      its shared asset backend cannot be reconciled the app's Ingress simply
//      omits the paths, the app deploys anyway, and every one of them 404s.
//      That is not hypothetical — it is what 39 of 40 red checks were.
//
// So the app uses an ABSOLUTE url built from an INJECTED origin: correct
// wherever it is deployed, and carrying no hostname that can go stale.
// server.js substitutes USERNODE_PLATFORM_ORIGIN into the three files that
// reference it, which is why none of them is served off disk.
//
// Run with: node --test tests/platform-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const PLACEHOLDER = '__USERNODE_PLATFORM_ORIGIN__';
const SERVER = read('server.js');
const TEMPLATES = [
  ['public/index.html', read('public', 'index.html')],
  ['public/landing.html', read('public', 'landing.html')],
  ['public/sw.js', read('public', 'sw.js')],
];
const ASSETS = ['/usernode-tailwind/v1/tailwind.js', '/usernode-native/v1/native.css',
                '/usernode-native/v1/native.js', '/usernode-bridge/v1/bridge.js'];

test('failure 1: nothing in the app names a platform hostname', () => {
  for (const [name, src] of TEMPLATES) {
    assert.doesNotMatch(src, /usernodelabs\.org|onhomeroom\.com/,
      `${name} names a platform hostname. It goes stale the next time the ` +
      `platform moves — use ${PLACEHOLDER}, which server.js substitutes.`);
  }
  // server.js keeps exactly one, as the documented standalone-deploy fallback.
  assert.equal(SERVER.split('onhomeroom.com').length - 1, 1,
    'server.js should name the platform exactly once, as PLATFORM_ORIGIN_FALLBACK');
});

test('failure 2: no platform asset is reached by a bare relative path', () => {
  // The regression that put 39 of 40 checks red. Every reference has to carry
  // an origin, because the app-origin routing that would serve a bare path is
  // best-effort and fails by omission, with nothing the app can detect.
  const bare = new RegExp(`(?<!${PLACEHOLDER})/usernode-(?:bridge|native|tailwind)/`, 'g');
  for (const [name, src] of TEMPLATES) {
    // sw.js builds its URLs by concatenation, so its path fragments are fine;
    // what matters there is that they are mapped onto PLATFORM_ORIGIN.
    if (name === 'public/sw.js') continue;
    assert.deepEqual(src.match(bare) || [], [],
      `${name} reaches a platform asset by bare path — it 404s wherever the ` +
      'platform asset backend has not been reconciled onto this app.');
  }
  assert.match(read('public', 'sw.js'), /\]\.map\(p => PLATFORM_ORIGIN \+ p\)/,
    'sw.js must map its asset paths onto the injected origin');
});

test('every hosted asset is loaded, and from the injected origin', () => {
  const [, INDEX] = TEMPLATES[0];
  const [, LANDING] = TEMPLATES[1];
  for (const a of ASSETS.slice(0, 3)) {
    assert.ok(INDEX.includes(`"${PLACEHOLDER}${a}"`), `index.html must load ${a}`);
    assert.ok(LANDING.includes(`"${PLACEHOLDER}${a}"`), `landing.html must load ${a}`);
  }
  // The bridge is the shell's alone, and it is not optional: it is how the app
  // answers the platform frame, which is what lets it open offline at all.
  assert.ok(INDEX.includes(`"${PLACEHOLDER}/usernode-bridge/v1/bridge.js"`),
    'index.html must load the bridge — without it the shell refuses to mount offline');
});

test('the server renders every file that carries the placeholder', () => {
  // A template served off disk ships the placeholder as a literal: a dead
  // asset URL, or — for /index.html, which the worker precaches as the offline
  // shell — a saved copy that is broken for as long as it is cached.
  for (const file of ['landing.html', 'index.html', 'sw.js']) {
    assert.match(SERVER, new RegExp(`renderTemplate\\('${file}'\\)`),
      `server.js must render ${file} rather than send it off disk`);
  }
  for (const route of ['/landing.html', '/index.html', '/sw.js']) {
    assert.ok(SERVER.includes(`app.get('${route}'`),
      `${route} needs its own route, ahead of express.static`);
  }
  assert.ok(SERVER.indexOf("app.get('/index.html'") < SERVER.indexOf('express.static'),
    'and those routes must come BEFORE express.static, or it serves the raw template first');
  assert.ok(!SERVER.includes("sendFile(path.join(__dirname, 'public', 'index.html'))"),
    'no path may still send the raw shell off disk');
});

test('rendering leaves nothing placeholder-shaped behind', () => {
  for (const [name, src] of TEMPLATES) {
    const rendered = src.split(PLACEHOLDER).join('https://platform.example');
    assert.doesNotMatch(rendered, /__USERNODE_/,
      `${name} still carries a placeholder after rendering — the spellings have drifted`);
  }
  const [, LANDING] = TEMPLATES[1];
  const rendered = LANDING.split(PLACEHOLDER).join('https://platform.example');
  assert.ok(rendered.includes('href="https://platform.example"'),
    "the landing page's link to the platform resolves to the injected origin");
  assert.ok(rendered.includes('"https://platform.example/usernode-native/v1/native.css"'),
    'and so do its asset tags');
});

test('a bad USERNODE_PLATFORM_ORIGIN is rejected rather than written into the page', () => {
  // The value lands in an href, in JS string literals and in every asset URL,
  // so it is validated as a plain http(s) origin instead of being trusted.
  const block = SERVER.slice(SERVER.indexOf('const PLATFORM_ORIGIN ='),
                             SERVER.indexOf('function renderTemplate'));
  assert.match(block, /new URL\(/, 'the injected value is parsed, not interpolated blind');
  assert.match(block, /u\.origin === raw/,
    'and it has to BE an origin — a value carrying a path or a query is refused');
  assert.match(block, /PLATFORM_ORIGIN_FALLBACK/, 'with a fallback when it is unset or unusable');
});
