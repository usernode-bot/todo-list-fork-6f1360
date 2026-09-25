// What the service worker must NEVER do, and the one thing it must do fast.
//
// The rules in docs/app-slow-network-loading.md are one-way doors: a worker
// that answers /api/* from cache hands the previous user's authenticated data
// to whoever opens the app next, because an offline load carries no token to
// authenticate it. A worker that buffers an SSE stream makes the connection
// look hung. Neither failure is visible in a screenshot, so neither is caught
// by a dapp.json check — they are pinned here instead.
//
// public/sw.js is written for a ServiceWorkerGlobalScope, so it is run in a vm
// with a fake one: listeners are captured, a fetch event is synthesised, and
// what the handler does with respondWith is the assertion.
//
// Run with: node --test tests/sw-offline.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
// server.js substitutes the platform's origin into sw.js and index.html at
// boot, so the tests read them the same way — the raw templates are not what
// any browser ever runs.
const PLATFORM = 'https://platform.example';
const render = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8')
  .split('__USERNODE_PLATFORM_ORIGIN__').join(PLATFORM);
const SW_SRC = render('public', 'sw.js');
const INDEX = render('public', 'index.html');
const ORIGIN = 'https://todo-list-b91765.example';

// Load sw.js and hand back its captured listeners plus the caches it saw.
function loadWorker({ shellCached = true, network = null } = {}) {
  const listeners = {};
  const store = new Map();               // cacheName -> Map(url -> response)
  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  const fakeCache = (name) => ({
    match: async (req) => cacheFor(name).get(typeof req === 'string' ? req : req.url) || undefined,
    put: async (req, res) => { cacheFor(name).set(typeof req === 'string' ? req : req.url, res); },
    keys: async () => [...cacheFor(name).keys()],
    add: async () => {},
  });
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    URL, Response: class { constructor(b, i) { this.body = b; Object.assign(this, i); } },
    AbortController, setTimeout, clearTimeout, Promise,
    // Default: the network is unreachable, which is the offline case. Pass
    // `network` to model a REACHABLE one — the difference test 5 turns on.
    fetch: async (req) => {
      if (network) return network(typeof req === 'string' ? req : req.url);
      throw new Error('offline');
    },
    caches: {
      open: async (n) => fakeCache(n),
      keys: async () => [...store.keys()],
      delete: async (n) => store.delete(n),
      match: async (req, opts) => {
        const key = typeof req === 'string' ? req : req.url;
        if (opts && opts.cacheName) return cacheFor(opts.cacheName).get(key);
        for (const m of store.values()) if (m.has(key)) return m.get(key);
        return undefined;
      },
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    },
  };
  sandbox.self.self = sandbox.self;
  sandbox.addEventListener = sandbox.self.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox);
  // Seed the precached shell the way a real install would.
  if (shellCached) {
    const shellName = [...store.keys()].find((n) => /-shell$/.test(n)) || 'seed-shell';
    cacheFor(shellName).set('/index.html', { body: 'SHELL', ok: true });
    // sw.js opens its own cache by name; make sure that name is the one used.
    const m = SW_SRC.match(/const CACHE_VERSION = '([^']+)'/);
    if (m) cacheFor(m[1] + '-shell').set('/index.html', { body: 'SHELL', ok: true });
  }
  return { listeners, store };
}

// Synthesise a fetch event and report whether the worker claimed it.
function dispatch(listeners, { url, method = 'GET', mode = 'no-cors', accept = null }) {
  let responded = null;
  const event = {
    request: {
      url, method, mode,
      headers: { get: (h) => (h.toLowerCase() === 'accept' ? accept : null) },
    },
    respondWith: (p) => { responded = p; },
    waitUntil: () => {},
  };
  listeners.fetch(event);
  return { claimed: responded !== null, responded };
}

test('the worker never touches /api/*', () => {
  // Asserted with the network REACHABLE: "not claimed" has to mean the worker
  // declined, not that it tried and fell back.
  const { listeners } = loadWorker({ network: () => ({ body: 'NET', ok: true }) });
  for (const p of ['/api/lists', '/api/lists/1', '/api/lists/1/members']) {
    const r = dispatch(listeners, { url: ORIGIN + p });
    assert.equal(r.claimed, false,
      `${p} must go straight to the network — a cached API answer is the previous user's data`);
  }
  // /api/* is refused twice over: the dedicated bypass below, and the
  // CACHEABLE_PATHS allowlist which it is not a member of. Losing either one
  // still leaves the invariant above true, so the explicit bypass — the one a
  // reader is meant to find — is pinned by name as well.
  assert.match(SW_SRC, /url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,80}return;/,
    'the explicit /api/ bypass is still the first thing the fetch handler does');
});

test('the worker never touches a non-GET', () => {
  const { listeners } = loadWorker();
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const r = dispatch(listeners, { url: ORIGIN + '/index.html', method });
    assert.equal(r.claimed, false, `${method} must never be intercepted`);
  }
});

test('the worker never buffers an SSE stream', () => {
  const { listeners } = loadWorker();
  const r = dispatch(listeners, { url: ORIGIN + '/api/lists/1/events', accept: 'text/event-stream' });
  assert.equal(r.claimed, false, 'a cached stream never ends and the connection looks hung');
});

test('an in-app navigation is served cache-first — the slow-network fix', async () => {
  // The network is REACHABLE and answers with something distinguishable. That
  // is the whole point: network-first would return NET here, and on a weak
  // signal NET is what arrives eight seconds late. Cache-first returns SHELL.
  const { listeners } = loadWorker({ network: () => ({ body: 'NET', ok: true }) });
  const r = dispatch(listeners, { url: ORIGIN + '/?token=abc.def.ghi', mode: 'navigate' });
  assert.equal(r.claimed, true, 'the navigation is claimed');
  const res = await r.responded;
  assert.equal(res.body, 'SHELL',
    'the cached shell ships immediately rather than waiting out a crawling socket');
});

test('a token-less navigation stays network-first, so the landing page survives', async () => {
  // `/` is the public landing page for a logged-out visitor and the app for an
  // authenticated one, so cache-first here would show the app to the wrong
  // person on any device that had opened it before.
  const { listeners } = loadWorker({ network: () => ({ body: 'LANDING', ok: true }) });
  const r = dispatch(listeners, { url: ORIGIN + '/', mode: 'navigate' });
  assert.equal(r.claimed, true, 'still claimed — it owns the offline fallback');
  const res = await r.responded;
  assert.equal(res.body, 'LANDING',
    'the cached app shell must not pre-empt the landing page while the network is reachable');
});

test('a token-less navigation still falls back to the shell when truly offline', async () => {
  const { listeners } = loadWorker();   // no network at all
  const r = dispatch(listeners, { url: ORIGIN + '/', mode: 'navigate' });
  const res = await r.responded;
  assert.equal(res.body, 'SHELL', 'offline, the saved shell is the only thing there is');
});

test('cross-origin requests outside the asset hosts are left alone', () => {
  const { listeners } = loadWorker();
  const r = dispatch(listeners, { url: 'https://example.com/tracker.js' });
  assert.equal(r.claimed, false);
});

// ── the no-token path, which is the other one-way door ──────────────────
//
// An offline load arrives with NO token. The rule is that this must never be
// read as "anonymous" and used to clear the real user's namespace. That lives
// in a 200 KB inline script, so it is pinned at source level — shallow, but it
// catches the guard being dropped, which is the failure that actually happened
// (issue #47).
test('a token-less load never clears per-user data', () => {
  assert.match(INDEX, /const HAVE_TOKEN_IDENTITY = !!\(jwt && jwt\.id != null\)/,
    'the "did THIS load carry a token" flag still exists');
  const sweep = INDEX.slice(INDEX.indexOf('function migrateStorage'),
                            INDEX.indexOf('function cacheSet('));
  assert.ok(sweep.includes('HAVE_TOKEN_IDENTITY &&'),
    'the cross-namespace sweep is gated on this load having had a token');
  assert.match(INDEX, /: readLastUser\(\)/,
    'and a token-less load falls back to the remembered user rather than a fresh anonymous namespace');
});

// ── the platform's own files ────────────────────────────────────────────
//
// They are matched by the INJECTED origin rather than by a hostname this file
// names, so these cases are what prove the injection is actually load-bearing:
// with the substitution broken, PLATFORM_ORIGIN is a literal placeholder, no
// URL ever matches it, and the worker quietly stops caching the kit — which
// looks perfect online and comes up with no stylesheet and no bridge offline.
test('the platform kit is served from cache on an offline load', async () => {
  const { listeners, store } = loadWorker();
  const m = SW_SRC.match(/const CACHE_VERSION = '([^']+)'/);
  store.set(m[1] + '-assets', new Map([
    [PLATFORM + '/usernode-native/v1/native.css', { body: 'KIT', ok: true }],
  ]));

  const r = dispatch(listeners, { url: PLATFORM + '/usernode-native/v1/native.css' });
  assert.equal(r.claimed, true,
    'a platform asset must be claimed by the worker, not passed to a network that is down');
  assert.equal((await r.responded).body, 'KIT', 'and answered from the cache');
});

test('the platform assets keep their own cache, separate from the app shell', async () => {
  // Not the app's files: a shell bump should not have to reason about them.
  // staleWhileRevalidate clones the response before caching it, and writes the
  // clone on a detached promise — so the fake needs a clone() and the write
  // needs a turn of the event loop to land.
  const network = () => { const r = { body: 'NET', ok: true }; r.clone = () => r; return r; };
  const { listeners, store } = loadWorker({ network });
  const m = SW_SRC.match(/const CACHE_VERSION = '([^']+)'/);
  const r = dispatch(listeners, { url: PLATFORM + '/usernode-bridge/v1/bridge.js' });
  await r.responded;
  await new Promise(done => setImmediate(done));
  assert.ok(store.get(m[1] + '-assets')?.has(PLATFORM + '/usernode-bridge/v1/bridge.js'),
    'the bridge is revalidated into the asset cache');
  assert.ok(!store.get(m[1] + '-shell')?.has(PLATFORM + '/usernode-bridge/v1/bridge.js'),
    'and never into the shell cache');
});

test('an unrelated same-origin path is still left alone', () => {
  // The prefix rule must not have become "anything that looks platform-ish",
  // and it is scoped to the platform's origin — the same paths on THIS origin
  // are not the platform's files. /explorer-api/* must never be cached.
  const { listeners } = loadWorker({ network: () => ({ body: 'NET', ok: true }) });
  for (const p of ['/explorer-api/status', '/usernode-native/v1/native.js', '/sw.js']) {
    assert.equal(dispatch(listeners, { url: ORIGIN + p }).claimed, false,
      `${p} must go straight to the network`);
  }
});
