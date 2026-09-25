const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const USERNODE_JWT_PUBLIC_KEY = process.env.USERNODE_JWT_PUBLIC_KEY;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Where the platform itself lives, for the landing page's two "open it in
// Usernode" links. The platform injects USERNODE_PLATFORM_ORIGIN into every
// app's environment, derived from the domain that deployment actually runs on,
// and reading it is the whole point: a platform hostname written into this repo
// is a hostname that goes stale the next time the platform moves — which is
// exactly what happened, and what left these links pointing at a host that no
// longer answers. The literal below is only the standalone-deploy fallback.
//
// Validated rather than trusted: the value is interpolated into an href and
// into a JS string on the landing page, so anything that is not a plain http(s)
// origin is discarded instead of being written into the markup.
const PLATFORM_ORIGIN_FALLBACK = 'https://my.onhomeroom.com';
const PLATFORM_ORIGIN = (() => {
  const raw = String(process.env.USERNODE_PLATFORM_ORIGIN || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin === raw) return raw;
  } catch (_) { /* unset or unparseable — fall through */ }
  if (raw) console.warn('USERNODE_PLATFORM_ORIGIN is not a plain origin; ignoring it:', raw);
  return PLATFORM_ORIGIN_FALLBACK;
})();

// Three files carry the placeholder, so all three are rendered once at boot
// rather than per request. Read eagerly: an unreadable template should fail the
// container immediately, not on the first visitor.
function renderTemplate(file) {
  return fs
    .readFileSync(path.join(__dirname, 'public', file), 'utf8')
    .split('__USERNODE_PLATFORM_ORIGIN__')
    .join(PLATFORM_ORIGIN);
}

const LANDING_HTML = renderTemplate('landing.html');
const INDEX_HTML = renderTemplate('index.html');
const SW_JS = renderTemplate('sw.js');

function sendLanding(res) {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(LANDING_HTML);
}

function sendShell(res) {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(INDEX_HTML);
}

// Set by the shutdown handler at the bottom of this file; /health flips to 503
// as soon as the container starts draining.
let server = null;
let shuttingDown = false;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && USERNODE_JWT_PUBLIC_KEY) {
    try {
      const payload = jwt.verify(token, USERNODE_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: 'usernode:app:' + process.env.USERNODE_APP_ID,
      });
      if (payload.pur === 'iframe') req.user = payload;
    } catch {}
  }
  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The offline app shell's service worker. Served with no-cache so a redeployed
// worker is always picked up (a stale HTTP-cached sw.js would pin the old
// shell), and with Service-Worker-Allowed so it controls the whole origin.
// Needs no auth exception — the gate above only covers non-GET and /api/*.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  // Rendered, not sent off disk: the worker precaches the platform's files by
  // absolute URL, and that origin is injected like it is in the two HTML files.
  res.send(SW_JS);
});

// ---------------------------------------------------------------------------
// Access control
//
// A list is visible to its owner and to invited members. Invites are by
// username (no accept step), so a member row may predate the invitee ever
// opening the app — membership matches on user_id OR username
// (case-insensitive). When a username-only member shows up we backfill
// their user_id so future checks are exact.
// ---------------------------------------------------------------------------

async function getListRole(listId, user) {
  const { rows } = await pool.query(
    `SELECT l.*,
            (l.owner_id = $2) AS is_owner,
            (SELECT m.id FROM list_members m
              WHERE m.list_id = l.id
                AND (m.user_id = $2 OR LOWER(m.username) = LOWER($3))
              LIMIT 1) AS member_row_id
       FROM lists l WHERE l.id = $1`,
    [listId, user.id, user.username]
  );
  if (!rows.length) return { list: null, role: null };
  const list = rows[0];
  if (list.is_owner) return { list, role: 'owner' };
  if (list.member_row_id) {
    // Backfill user_id on username-only invites.
    await pool.query(
      `UPDATE list_members SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
      [user.id, list.member_row_id]
    );
    return { list, role: 'member' };
  }
  return { list, role: null };
}

// Resolves a category id to its list and checks the requester has access.
async function getCategoryAccess(categoryId, user) {
  const { rows } = await pool.query(`SELECT * FROM categories WHERE id = $1`, [categoryId]);
  if (!rows.length) return { category: null, list: null, role: null };
  const category = rows[0];
  const { list, role } = await getListRole(category.list_id, user);
  return { category, list, role };
}

// Resolves an item id to its category/list and checks access.
async function getItemAccess(itemId, user) {
  const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [itemId]);
  if (!rows.length) return { item: null, category: null, list: null, role: null };
  const item = rows[0];
  const { category, list, role } = await getCategoryAccess(item.category_id, user);
  return { item, category, list, role };
}

// ---------------------------------------------------------------------------
// SSE live updates
//
// Clients viewing a list subscribe to /api/lists/:id/events. Every mutation
// broadcasts a small "something changed" event to that list's subscribers,
// who refetch. Events carry the mutating client's id (x-client-id header)
// so the originating tab can ignore its own echo.
// ---------------------------------------------------------------------------

const listStreams = new Map(); // listId -> Set<res>

function broadcast(listId, event) {
  const subs = listStreams.get(Number(listId));
  if (!subs) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch (_) { /* dropped connection; close cleans up */ }
  }
}

function notify(listId, req, type = 'changed') {
  broadcast(listId, { type, sourceClient: req.headers['x-client-id'] || null });
}

function closeListStreams(listId) {
  const subs = listStreams.get(Number(listId));
  if (!subs) return;
  for (const res of subs) { try { res.end(); } catch (_) {} }
  listStreams.delete(Number(listId));
}

// Keep connections alive through proxies that time out idle streams.
setInterval(() => {
  for (const subs of listStreams.values()) {
    for (const res of subs) { try { res.write(': ping\n\n'); } catch (_) {} }
  }
}, 25000).unref();

// EventSource can't set headers, so auth rides the ?token= query param,
// which the auth middleware already accepts.
app.get('/api/lists/:id/events', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const key = Number(list.id);
    let subs = listStreams.get(key);
    if (!subs) listStreams.set(key, (subs = new Set()));
    subs.add(res);
    req.on('close', () => {
      subs.delete(res);
      if (!subs.size) listStreams.delete(key);
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// Home: lists the user owns or is a member of. `activity` is the most
// recent item event by someone OTHER than the requester in the last week —
// the passive shared-list re-engagement hint rendered on the Home row.
app.get('/api/lists', async (req, res) => {
  try {
    if (IS_STAGING) await seedDemoListFor(req.user);
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.owner_id, l.owner_username, l.created_at, l.due_dates_enabled,
              (l.owner_id = $1) AS is_owner,
              (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS member_count,
              (SELECT COUNT(*) FROM items i JOIN categories c ON i.category_id = c.id
                WHERE c.list_id = l.id AND NOT i.checked) AS open_count,
              (SELECT COUNT(*) FROM items i JOIN categories c ON i.category_id = c.id
                WHERE c.list_id = l.id AND i.checked) AS done_count,
              (SELECT row_to_json(ev) FROM (
                 SELECT x.actor, x.verb, x.text FROM (
                   SELECT i.last_checked_by AS actor, 'checked' AS verb, i.text, i.completed_at AS at
                     FROM items i JOIN categories c ON i.category_id = c.id
                    WHERE c.list_id = l.id AND i.checked AND i.last_checked_by IS NOT NULL
                      AND LOWER(i.last_checked_by) <> LOWER($2)
                      AND i.completed_at > NOW() - INTERVAL '7 days'
                   UNION ALL
                   SELECT i.created_by AS actor, 'added' AS verb, i.text, i.created_at AS at
                     FROM items i JOIN categories c ON i.category_id = c.id
                    WHERE c.list_id = l.id AND i.created_by IS NOT NULL
                      AND LOWER(i.created_by) <> LOWER($2)
                      AND i.created_at > NOW() - INTERVAL '7 days'
                 ) x ORDER BY x.at DESC LIMIT 1
               ) ev) AS activity
         FROM lists l
        WHERE l.owner_id = $1
           OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id
                        AND (m.user_id = $1 OR LOWER(m.username) = LOWER($2)))
        ORDER BY l.created_at DESC, l.id DESC`,
      [req.user.id, req.user.username]
    );
    res.json({ lists: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a list (+ its default "General" category).
app.post('/api/lists', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'List name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING *`,
      [name, req.user.id, req.user.username]
    );
    await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0)`,
      [rows[0].id]
    );
    await client.query('COMMIT');
    res.json({ list: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Full list detail: categories, items (unchecked first, then checked), members.
app.get('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });

    const [cats, items, members] = await Promise.all([
      pool.query(`SELECT id, name, is_default, sort_order FROM categories
                   WHERE list_id = $1 ORDER BY sort_order, id`, [list.id]),
      // due_date/due_time go over the wire as plain strings via to_char: pg
      // would otherwise hand back a JS Date at the *server's* midnight, which
      // the client then re-interprets in its own zone and shifts by a day.
      pool.query(`SELECT i.id, i.category_id, i.text, i.checked, i.sort_order, i.completed_at, i.created_by, i.last_checked_by,
                         to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
                         to_char(i.due_time, 'HH24:MI') AS due_time
                    FROM items i JOIN categories c ON i.category_id = c.id
                   WHERE c.list_id = $1
                   ORDER BY i.checked, i.sort_order, i.id`, [list.id]),
      pool.query(`SELECT id, user_id, username, added_at FROM list_members
                   WHERE list_id = $1 ORDER BY added_at`, [list.id]),
    ]);

    res.json({
      list: {
        id: list.id, name: list.name, owner_id: list.owner_id, owner_username: list.owner_username,
        due_dates_enabled: !!list.due_dates_enabled,
      },
      role,
      categories: cats.rows,
      items: items.rows,
      members: members.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a list and/or flip its due-dates setting (owner only). Both fields
// are optional, so a settings-only PATCH doesn't have to resend the name.
app.patch('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can change list settings' });

    const wantsName = req.body.name !== undefined;
    const wantsDates = typeof req.body.due_dates_enabled === 'boolean';
    if (!wantsName && !wantsDates) return res.status(400).json({ error: 'Nothing to update' });

    if (wantsName) {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'List name is required' });
      await pool.query(`UPDATE lists SET name = $1 WHERE id = $2`, [name, list.id]);
    }
    if (wantsDates) {
      await pool.query(`UPDATE lists SET due_dates_enabled = $1 WHERE id = $2`,
        [req.body.due_dates_enabled, list.id]);
      // Turning the setting off keeps the dates on disk: flipping it back on
      // restores what was there rather than silently destroying data.
    }
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a list (owner only). Cascades to members/categories/items.
app.delete('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete the list' });
    await pool.query(`DELETE FROM lists WHERE id = $1`, [list.id]);
    notify(list.id, req, 'list-deleted');
    closeListStreams(list.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Markdown import — bulk-create categories/items from a parsed markdown
// payload: [{ name, items: [{ text, checked }] }]. The client does the
// parsing; these endpoints just validate and insert.
// ---------------------------------------------------------------------------

const MAX_IMPORT_CATS = 200;
const MAX_IMPORT_ITEMS = 3000;

function invalidImportPayload(categories) {
  if (!Array.isArray(categories) || !categories.length) return 'categories must be a non-empty array';
  if (categories.length > MAX_IMPORT_CATS) return `Too many categories (max ${MAX_IMPORT_CATS})`;
  let count = 0;
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return 'Every category needs a name';
    if (!Array.isArray(c.items)) return 'Every category needs an items array';
    for (const it of c.items) {
      if (!it || typeof it.text !== 'string' || !it.text.trim()) return 'Every item needs text';
      count++;
    }
  }
  if (count > MAX_IMPORT_ITEMS) return `Too many items (max ${MAX_IMPORT_ITEMS})`;
  return null;
}

// Inserts imported categories/items into a list. Category names are matched
// case-insensitively against existing categories (so repeated names across
// the markdown's active/completed blocks merge); new items append to the end
// of the matching checked/unchecked section.
async function importCategoriesInto(client, listId, categories, username) {
  const { rows: existing } = await client.query(
    `SELECT id, name FROM categories WHERE list_id = $1`, [listId]);
  const byName = new Map(existing.map(c => [c.name.trim().toLowerCase(), c.id]));
  let catSort = Number((await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) AS max FROM categories WHERE list_id = $1`, [listId]
  )).rows[0].max);

  let hasDefault = (await client.query(
    `SELECT 1 FROM categories WHERE list_id = $1 AND is_default LIMIT 1`, [listId]
  )).rows.length > 0;

  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    let catId = byName.get(key);
    if (!catId) {
      // An imported "General" becomes the list's default (uncategorized)
      // bucket when it doesn't have one yet, so exports round-trip.
      const asDefault = !hasDefault && key === 'general';
      if (asDefault) hasDefault = true; else catSort++;
      const r = await client.query(
        `INSERT INTO categories (list_id, name, is_default, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [listId, c.name.trim(), asDefault, asDefault ? 0 : catSort]);
      catId = r.rows[0].id;
      byName.set(key, catId);
    }
    const counters = {};
    for (const checked of [false, true]) {
      counters[checked] = Number((await client.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS max FROM items WHERE category_id = $1 AND checked = $2`,
        [catId, checked])).rows[0].max);
    }
    for (const it of c.items) {
      const checked = !!it.checked;
      counters[checked]++;
      // completed_at / last_checked_by are computed here rather than via
      // CASE WHEN $n expressions — reusing a parameter in contexts with
      // different deduced types makes Postgres fail with "inconsistent
      // types deduced for parameter".
      await client.query(
        `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [catId, it.text.trim(), checked, counters[checked],
         checked ? new Date() : null, username, checked ? username : null]);
    }
  }
}

// Create a brand-new list from imported markdown.
app.post('/api/lists/import', async (req, res) => {
  const name = (req.body.name || '').trim() || 'Imported list';
  const badPayload = invalidImportPayload(req.body.categories);
  if (badPayload) return res.status(400).json({ error: badPayload });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING *`,
      [name, req.user.id, req.user.username]);
    // No pre-created "General" here — the imported categories themselves
    // satisfy the at-least-one-category rule (payload is validated non-empty).
    await importCategoriesInto(client, rows[0].id, req.body.categories, req.user.username);
    await client.query('COMMIT');
    res.json({ list: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Import markdown into an existing list (owner or member). mode 'add'
// (default) merges into existing categories; mode 'replace' wipes the list's
// categories/items first — safe to do inside the transaction because the
// validated payload is non-empty, so the at-least-one-category rule holds.
app.post('/api/lists/:id/import', async (req, res) => {
  const badPayload = invalidImportPayload(req.body.categories);
  if (badPayload) return res.status(400).json({ error: badPayload });
  const mode = req.body.mode === 'replace' ? 'replace' : 'add';
  const client = await pool.connect();
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    await client.query('BEGIN');
    if (mode === 'replace') {
      await client.query(`DELETE FROM categories WHERE list_id = $1`, [list.id]);
    }
    await importCategoriesInto(client, list.id, req.body.categories, req.user.username);
    await client.query('COMMIT');
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// The platform user directory
//
// Invite autocomplete and invite validation both read the PLATFORM's user
// directory, not a roster of people this app happens to have met. The app used
// to keep its own `known_users` table for this, which rejected every real
// Usernode account that had not yet opened Todo List — issue #50.
//
// Two endpoints, both read-only, both returning only `{ id, username }`:
//   GET /users/search?q=<prefix>&limit=<n>   prefix typeahead
//   GET /users/lookup?username=<handle>      exact existence check
//
// USERNODE_PLATFORM_API_URL is injected into BOTH production and staging
// (unlike every other platform credential pair), so one code path covers both.
// The app token only exists in production; the /users/* routes are the one
// place the platform authenticates from the user token alone, which is what
// makes these work in a staging preview. So the app-token header is
// conditional on the value being present — never on USERNODE_ENV.
// ---------------------------------------------------------------------------

const PLATFORM_API_URL = process.env.USERNODE_PLATFORM_API_URL;
const PLATFORM_APP_TOKEN = process.env.USERNODE_LLM_PROXY_TOKEN;

// The auth middleware keeps only the decoded payload on req.user, so the raw
// bearer string has to be read again to forward it.
function rawUserToken(req) {
  return req.query.token || req.headers['x-usernode-token'] || '';
}

function directoryHeaders(req) {
  const headers = { 'x-usernode-user-token': rawUserToken(req) };
  if (PLATFORM_APP_TOKEN) headers['x-usernode-app-token'] = PLATFORM_APP_TOKEN;
  return headers;
}

// Ask the directory a question. Returns { ok: true, data } ONLY for a 2xx JSON
// body; every other outcome — no platform URL, no user token, a non-2xx
// (including 429 rate_limited), a timeout, a parse failure — is { ok: false },
// meaning "the question was not answered".
//
// That distinction is the load-bearing rule of this whole feature: an
// unanswered question must never be read as "this user does not exist". This
// never throws to its caller.
async function directoryGet(req, pathAndQuery, timeoutMs) {
  if (!PLATFORM_API_URL) return { ok: false };
  const userToken = rawUserToken(req);
  if (!userToken) return { ok: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(PLATFORM_API_URL + pathAndQuery, {
      headers: directoryHeaders(req),
      signal: ctl.signal,
    });
    if (!resp.ok) return { ok: false };
    return { ok: true, data: await resp.json() };
  } catch (err) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const DIRECTORY_SEARCH_TIMEOUT_MS = 2500;
const DIRECTORY_LOOKUP_TIMEOUT_MS = 4000;

// Handles already spoken for on this list: the owner plus every member.
async function listHandles(list) {
  const { rows } = await pool.query(
    `SELECT username FROM list_members WHERE list_id = $1`, [list.id]
  );
  const taken = new Set(rows.map(r => (r.username || '').toLowerCase()));
  if (list.owner_username) taken.add(list.owner_username.toLowerCase());
  return taken;
}

// ---------------------------------------------------------------------------
// Members (owner only; invites take effect immediately)
// ---------------------------------------------------------------------------

// Typeahead for the invite box: platform handles matching a prefix, minus the
// list owner and anyone already on the list. Owner-only, mirroring who may
// invite.
//
// `exists` is computed BEFORE the owner/member filter, so the box can say
// "already on this list" instead of wrongly claiming nobody by that name
// exists. `unavailable: true` means the lookup could not run — the client
// degrades open on it and never blocks an invite.
app.get('/api/lists/:id/member-suggestions', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can invite members' });
    const q = (req.query.q || '').trim().replace(/^@/, '');
    // An empty/1-char prefix would be a request to enumerate the platform, and
    // the directory rate limit (120/min per app+user, shared across both
    // endpoints) is worth spending on real queries.
    if (q.length < 2) {
      return res.json({ usernames: [], exists: false, filtered: false, hasMore: false, unavailable: false });
    }
    const hit = await directoryGet(
      req, '/users/search?q=' + encodeURIComponent(q) + '&limit=10',
      DIRECTORY_SEARCH_TIMEOUT_MS
    );
    if (!hit.ok) {
      return res.json({ usernames: [], exists: false, filtered: false, hasMore: false, unavailable: true });
    }
    const users = Array.isArray(hit.data && hit.data.users) ? hit.data.users : [];
    const names = users.map(u => u && u.username).filter(Boolean);
    const exists = names.some(n => n.toLowerCase() === q.toLowerCase());
    const taken = await listHandles(list);
    const usernames = names.filter(n => !taken.has(n.toLowerCase())).slice(0, 8);
    res.json({
      usernames,
      exists,
      filtered: exists && taken.has(q.toLowerCase()),
      hasMore: !!(hit.data && hit.data.has_more),
      unavailable: false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lists/:id/members', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can invite members' });
    const username = (req.body.username || '').trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Username is required' });
    if (username.toLowerCase() === (list.owner_username || '').toLowerCase()) {
      return res.status(400).json({ error: 'You already own this list' });
    }
    // The authoritative existence check. An explicit `found === false` is the
    // ONLY thing that may reject an invite — a lookup that could not run
    // degrades open and accepts the handle as typed, because "we couldn't ask"
    // is not "that person doesn't exist".
    const hit = await directoryGet(
      req, '/users/lookup?username=' + encodeURIComponent(username),
      DIRECTORY_LOOKUP_TIMEOUT_MS
    );
    const answered = hit.ok && typeof hit.data.found === 'boolean';
    if (answered && hit.data.found === false) {
      return res.status(422).json({ error: `There’s no @${username} on Usernode.` });
    }
    // Stored under the directory's canonical spelling, so inviting "BOB"
    // doesn't leave "BOB" in the members list of someone whose handle is
    // "bob". `user_id` is deliberately NOT written from the directory: access
    // is granted on it (see getListRole), and the username match already
    // backfills it correctly the first time the invitee shows up.
    const canonical = (answered && hit.data.found && hit.data.user && hit.data.user.username)
      || username;
    const { rows } = await pool.query(
      `INSERT INTO list_members (list_id, username) VALUES ($1, $2)
       ON CONFLICT (list_id, lower(username)) DO NOTHING
       RETURNING *`,
      [list.id, canonical]
    );
    if (!rows.length) return res.status(409).json({ error: `@${canonical} is already a member` });
    notify(list.id, req);
    res.json({ member: rows[0], unverified: !answered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lists/:id/members/:memberId', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove members' });
    await pool.query(`DELETE FROM list_members WHERE id = $1 AND list_id = $2`,
                     [req.params.memberId, list.id]);
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Categories (owner + members)
// ---------------------------------------------------------------------------

app.post('/api/lists/:id/categories', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const { rows } = await pool.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MAX(sort_order) FROM categories WHERE list_id = $1), 0) + 1)
       RETURNING *`,
      [list.id, name]
    );
    notify(list.id, req);
    res.json({ category: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/categories/:id', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    await pool.query(`UPDATE categories SET name = $1 WHERE id = $2`, [name, category.id]);
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a category and its items (FK cascade). Any category can be deleted
// — including "General" — as long as it isn't the list's last one; every
// list must keep at least one category so new items have a home.
app.delete('/api/categories/:id', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE list_id = $1`, [category.list_id]);
    if (rows[0].n <= 1) {
      return res.status(400).json({ error: "Can't delete the only category — lists need at least one" });
    }
    await pool.query(`DELETE FROM categories WHERE id = $1`, [category.id]);
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist a drag-and-drop reorder of a list's categories. Takes the full
// ordered array of category ids; positions are assigned from array order.
app.post('/api/lists/:id/reorder-categories', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const ids = req.body.categoryIds;
    if (!Array.isArray(ids) || !ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'categoryIds must be an array of ids' });
    }
    // The default (uncategorized) bucket is pinned first and never reorders.
    await pool.query(
      `UPDATE categories c SET sort_order = x.ord
         FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
        WHERE c.id = x.id AND c.list_id = $2 AND NOT c.is_default`,
      [ids, list.id]
    );
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist a drag-and-drop reorder of items within one section (unchecked or
// checked) of a category. Takes that section's full ordered array of item
// ids; sort_order is assigned from array order. The checked and unchecked
// sections keep independent sequences, which is fine — display always
// filters by checked state before sorting.
app.post('/api/categories/:id/reorder-items', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const ids = req.body.itemIds;
    if (!Array.isArray(ids) || !ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'itemIds must be an array of ids' });
    }
    await pool.query(
      `UPDATE items i SET sort_order = x.ord
         FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
        WHERE i.id = x.id AND i.category_id = $2`,
      [ids, category.id]
    );
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Items (owner + members)
// ---------------------------------------------------------------------------

// The default category is the list's invisible "uncategorized" bucket.
// Older lists can lack one (the boot migration demotes renamed defaults),
// so it's created on demand.
async function ensureDefaultCategory(listId) {
  const { rows } = await pool.query(
    `SELECT * FROM categories WHERE list_id = $1 AND is_default ORDER BY id LIMIT 1`,
    [listId]);
  if (rows.length) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO categories (list_id, name, is_default, sort_order)
     VALUES ($1, 'General', TRUE, 0) RETURNING *`,
    [listId]);
  return created[0];
}

// Idempotency key for item creates. The client sends one per queued `add` op,
// so a create it had to retry (a timeout that actually landed, a replay after a
// reload) returns the row it already made instead of a duplicate. Anything that
// isn't a short, safe token is ignored rather than rejected — an old client
// sending nothing must keep working.
const CLIENT_OP_ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
function clientOpId(body) {
  const v = body && body.client_op_id;
  return typeof v === 'string' && CLIENT_OP_ID_RE.test(v) ? v : null;
}

// Looks up a previous create by its idempotency key and re-checks access, so a
// retry can only ever return a row the caller is still allowed to see.
async function itemByClientOpId(opId, user) {
  if (!opId) return null;
  const { rows } = await pool.query(`SELECT id FROM items WHERE client_op_id = $1`, [opId]);
  if (!rows.length) return null;
  const { item, category, role } = await getItemAccess(rows[0].id, user);
  return item && role ? { item, category } : null;
}

// Quick-add: create an item directly on a list; it lands in the default
// (uncategorized) bucket. Returns the category too, in case it was created
// just now and the client doesn't know it yet.
app.post('/api/lists/:id/items', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const opId = clientOpId(req.body);
    // Already created by an earlier attempt of this same op: hand back that row
    // (no second insert, no second notify — nothing changed).
    const prior = await itemByClientOpId(opId, req.user);
    if (prior) return res.json(prior);
    const category = await ensureDefaultCategory(list.id);
    const { rows } = await pool.query(
      `INSERT INTO items (category_id, text, checked, sort_order, created_by, client_op_id)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MIN(sort_order) FROM items WHERE category_id = $1 AND NOT checked), 1) - 1,
               $3, $4)
       RETURNING *`,
      [category.id, text, req.user.username, opId]
    );
    notify(list.id, req);
    res.json({ item: rows[0], category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories/:id/items', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const opId = clientOpId(req.body);
    const prior = await itemByClientOpId(opId, req.user);
    if (prior) return res.json({ item: prior.item });
    const { rows } = await pool.query(
      `INSERT INTO items (category_id, text, checked, sort_order, created_by, client_op_id)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MIN(sort_order) FROM items WHERE category_id = $1 AND NOT checked), 1) - 1,
               $3, $4)
       RETURNING *`,
      [category.id, text, req.user.username, opId]
    );
    notify(category.list_id, req);
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit text, move to another category, and/or toggle checked. Checking moves
// the item to the bottom of the checked section of its category; unchecking
// moves it to the bottom of the unchecked section. A category move drops the
// item at the end of the matching section of the target category.
app.patch('/api/items/:id', async (req, res) => {
  try {
    const { item, list, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });

    if (typeof req.body.text === 'string') {
      const text = req.body.text.trim();
      if (!text) return res.status(400).json({ error: 'Item text is required' });
      await pool.query(`UPDATE items SET text = $1 WHERE id = $2`, [text, item.id]);
    }

    let categoryId = item.category_id;
    if (Number.isInteger(req.body.category_id) && req.body.category_id !== item.category_id) {
      // The target must belong to the same list as the item's current category.
      const { rows: target } = await pool.query(
        `SELECT c2.id FROM categories c2 JOIN categories c1 ON c1.list_id = c2.list_id
          WHERE c2.id = $1 AND c1.id = $2`,
        [req.body.category_id, item.category_id]
      );
      if (!target.length) return res.status(400).json({ error: 'Target category not found in this list' });
      await pool.query(
        `UPDATE items SET
           category_id = $1,
           sort_order = COALESCE((SELECT MAX(sort_order) FROM items
                                   WHERE category_id = $1 AND checked = $2), 0) + 1
         WHERE id = $3`,
        [target[0].id, item.checked, item.id]
      );
      categoryId = target[0].id;
    }

    if (typeof req.body.checked === 'boolean' && req.body.checked !== item.checked) {
      await pool.query(
        `UPDATE items SET
           checked = $1,
           completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           last_checked_by = $4,
           sort_order = COALESCE((SELECT MAX(sort_order) FROM items
                                   WHERE category_id = $2 AND checked = $1 AND id <> $3), 0) + 1
         WHERE id = $3`,
        [req.body.checked, categoryId, item.id, req.user.username]
      );
    }

    // Due date/time. Both accept null to clear. Validated against strict
    // wall-clock shapes so a malformed value can't reach pg as a cast error,
    // and clearing the date clears the time with it (a bare time is not a
    // thing this app can render or sort).
    if (req.body.due_date !== undefined) {
      const d = req.body.due_date;
      if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
        return res.status(400).json({ error: 'due_date must be YYYY-MM-DD or null' });
      }
      await pool.query(`UPDATE items SET due_date = $1::date WHERE id = $2`, [d, item.id]);
      if (d === null) await pool.query(`UPDATE items SET due_time = NULL WHERE id = $1`, [item.id]);
    }
    if (req.body.due_time !== undefined) {
      const t = req.body.due_time;
      if (t !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))) {
        return res.status(400).json({ error: 'due_time must be HH:MM or null' });
      }
      await pool.query(
        `UPDATE items SET due_time = CASE WHEN due_date IS NULL THEN NULL ELSE $1::time END
          WHERE id = $2`, [t, item.id]);
    }

    const { rows } = await pool.query(
      `SELECT id, category_id, text, checked, sort_order, completed_at, created_by, last_checked_by,
              to_char(due_date, 'YYYY-MM-DD') AS due_date,
              to_char(due_time, 'HH24:MI') AS due_time
         FROM items WHERE id = $1`, [item.id]);
    notify(list.id, req);
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const { item, list, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });
    await pool.query(`DELETE FROM items WHERE id = $1`, [item.id]);
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The landing page is the app's one templated file, so it is served by a route
// rather than off the static handler below — which would hand out the raw
// template with __USERNODE_PLATFORM_ORIGIN__ still in it. It needs naming
// explicitly because /landing.html is fetched directly as well as through the
// catch-all: the service worker caches it by that path, and a dapp.json check
// loads it.
app.get('/landing.html', (_req, res) => sendLanding(res));

// Same reason, and this one matters more: /index.html is what the service
// worker precaches as the offline shell, so a raw template here would save a
// copy with the placeholder baked in and every offline load would come up with
// no styling at all.
app.get('/index.html', (_req, res) => sendShell(res));

// index:false so `/` falls through to the auth-aware catch-all below —
// otherwise the static middleware hands the app shell to logged-out
// visitors, whose first API call then dies with "Not authenticated".
// `no-cache, must-revalidate` is NOT "don't cache" — it means "revalidate
// before reuse". The service worker refreshes the shell in the background on
// every load, and without this the browser's heuristic caching decides on its
// own how long to reuse these files. With it, that refresh is a conditional
// GET that comes back 304 when nothing changed: a round trip instead of a
// 200 KB download, which is the difference that matters on a weak signal.
// See docs/app-slow-network-loading.md in the platform repo.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.(?:html|js|css|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// Browsers request /favicon.ico unconditionally (no token attached). Without
// this route it falls through to the auth-gated catch-all below and logs a
// 401 in the console. An icon reveals nothing, so serve it openly.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// HTML shell: the app for authenticated users; for everyone else the public
// landing page — a live, client-side-only demo list whose items pitch the
// platform (spec §6.10). No app data is ever served to it.
app.get('*', (req, res) => {
  // sendFile bypasses the express.static handler above, so the revalidation
  // header has to be set here too — and this is the path that matters most,
  // because it is the one the app itself is loaded from.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  if (!req.user) {
    return sendLanding(res);
  }
  sendShell(res);
});

// ---------------------------------------------------------------------------
// Staging seed
//
// All four tables are staging:private, so staging starts with empty tables.
// Because lists are only visible to their owner/members, a boot-time seed
// owned by a fake user would be invisible to testers — instead each tester
// gets a demo list lazily created the first time they load Home with no
// lists of their own.
// ---------------------------------------------------------------------------

async function seedDemoListFor(user) {
  const { rows } = await pool.query(
    `SELECT 1 FROM lists
      WHERE owner_id = $1
         OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = lists.id
                      AND (m.user_id = $1 OR LOWER(m.username) = LOWER($2)))
      LIMIT 1`,
    [user.id, user.username]
  );
  if (rows.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const list = (await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING id`,
      ['Demo: Weekend Plans', user.id, user.username]
    )).rows[0];
    const general = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0) RETURNING id`,
      [list.id]
    )).rows[0];
    const groceries = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'Groceries', FALSE, 1) RETURNING id`,
      [list.id]
    )).rows[0];
    // Deliberately left with no items: the "No items yet" row is now the
    // primary way to add to an empty category, so staging needs one empty
    // category to exercise it.
    await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'Packing', FALSE, 2)`,
      [list.id]
    );
    // A category with items and NOTHING ticked. This is the case the old
    // header chevron couldn't do anything with (it only hid completed items),
    // so it is the primary state the whole-category collapse has to exercise.
    const errands = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'Errands', FALSE, 3) RETURNING id`,
      [list.id]
    )).rows[0];
    // A deliberately long name, so the header's truncation can be checked
    // against the grip and chevron after the alignment fix.
    const longCat = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order)
       VALUES ($1, 'Things to sort out before the trip', FALSE, 4) RETURNING id`,
      [list.id]
    )).rows[0];
    // A FINISHED category holding exactly one item. Its whole card is that one
    // ticked row, which is the case issue #51 reported as undroppable — so
    // staging needs one to exercise the drop lane and the cross-category move.
    const sorted = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'Sorted', FALSE, 5) RETURNING id`,
      [list.id]
    )).rows[0];
    await client.query(
      `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by) VALUES
         ($1, 'Plan Saturday hike', FALSE, 1, NULL, $5),
         ($1, 'Book dinner reservation', FALSE, 2, NULL, $5),
         ($1, 'Charge camera batteries', TRUE, 1, NOW(), $5),
         ($2, 'Trail mix', FALSE, 1, NULL, $5),
         ($2, 'Sparkling water', FALSE, 2, NULL, $5),
         ($2, 'Sunscreen', TRUE, 1, NOW(), $5),
         ($3, 'Return the library book', FALSE, 1, NULL, $5),
         ($3, 'Pick up the parcel', FALSE, 2, NULL, $5),
         ($3, 'Top up the travel card', FALSE, 3, NULL, $5),
         ($4, 'Check the tyre pressures', FALSE, 1, NULL, $5),
         ($4, 'Find the spare house key', FALSE, 2, NULL, $5),
         ($6, 'Renew the travel insurance', TRUE, 1, NOW(), $5)`,
      [general.id, groceries.id, errands.id, longCat.id, user.username, sorted.id]
    );
    // A second, shared list so the owner-inclusive member count is visible
    // on Home ("2 members" = the tester + staging-demo-user).
    const shared = (await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING id`,
      ['Demo: Shared Errands', user.id, user.username]
    )).rows[0];
    const sharedGeneral = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0) RETURNING id`,
      [shared.id]
    )).rows[0];
    // The checked row is attributed to the fake member so the Home screen's
    // shared-list activity line ("@staging-demo-user checked …") has data.
    await client.query(
      `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by) VALUES
         ($1, 'Pick up dry cleaning', FALSE, 1, NULL, $2, NULL),
         ($1, 'Take out recycling', TRUE, 1, NOW(), 'staging-demo-user', 'staging-demo-user')`,
      [sharedGeneral.id, user.username]
    );
    await client.query(
      `INSERT INTO list_members (list_id, username) VALUES ($1, 'staging-demo-user')`,
      [shared.id]
    );
    // A third list with due dates switched ON, so the dated presentation
    // (chips, "Today"/"Tomorrow", the overdue row) has data in staging.
    // Dates are relative to CURRENT_DATE so the seed never goes stale.
    const dated = (await client.query(
      `INSERT INTO lists (name, owner_id, owner_username, due_dates_enabled)
       VALUES ($1, $2, $3, TRUE) RETURNING id`,
      ['Demo: Due Dates', user.id, user.username]
    )).rows[0];
    const datedGeneral = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0) RETURNING id`,
      [dated.id]
    )).rows[0];
    await client.query(
      `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by, due_date, due_time) VALUES
         ($1, 'Renew library books', FALSE, 1, NULL, $2, CURRENT_DATE - 2, '17:00'),
         ($1, 'Call the dentist', FALSE, 2, NULL, $2, CURRENT_DATE, '09:30'),
         ($1, 'Water the plants', FALSE, 3, NULL, $2, CURRENT_DATE + 1, NULL),
         ($1, 'Submit expense report', FALSE, 4, NULL, $2, CURRENT_DATE + 6, '12:00'),
         ($1, 'Someday: learn to sail', FALSE, 5, NULL, $2, NULL, NULL)`,
      [datedGeneral.id, user.username]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Staging demo seed failed:', err.message);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema (idempotent, applied on boot)
// ---------------------------------------------------------------------------

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      owner_id INTEGER NOT NULL,
      owner_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Per-list opt-in for due dates. Defaults FALSE so every existing list —
    -- and every new one — stays exactly as dateless as it was before.
    ALTER TABLE lists ADD COLUMN IF NOT EXISTS due_dates_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    COMMENT ON TABLE lists IS 'staging:private';

    CREATE TABLE IF NOT EXISTS list_members (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER,
      username VARCHAR(255) NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE list_members IS 'staging:private';
    CREATE UNIQUE INDEX IF NOT EXISTS list_members_list_username_idx
      ON list_members (list_id, lower(username));

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE categories IS 'staging:private';

    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      last_checked_by VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE items ADD COLUMN IF NOT EXISTS last_checked_by VARCHAR(255);
    -- Client-supplied idempotency key for creates, so a retried add (a timeout
    -- that actually landed, a queued op replayed after a reload) can't insert
    -- the same item twice. Nullable: rows created before this column, seeded
    -- rows, and imports all keep NULL, which the partial index ignores.
    ALTER TABLE items ADD COLUMN IF NOT EXISTS client_op_id VARCHAR(64);
    -- Due date/time as wall-clock values, deliberately NOT timestamptz: "the
    -- 3rd at 9am" is what the user typed and must read back identically in
    -- every timezone. due_time is meaningless without due_date, so clearing
    -- the date clears the time (enforced in PATCH /api/items/:id).
    ALTER TABLE items ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE items ADD COLUMN IF NOT EXISTS due_time TIME;
    COMMENT ON TABLE items IS 'staging:private';
    CREATE INDEX IF NOT EXISTS items_category_idx ON items (category_id);
    CREATE INDEX IF NOT EXISTS items_due_idx ON items (due_date) WHERE due_date IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS items_client_op_id_key
      ON items (client_op_id) WHERE client_op_id IS NOT NULL;

    -- The app used to keep its own roster of everyone it had authenticated
    -- and validate invites against it, which rejected every real Usernode
    -- account that had not opened Todo List yet (issue #50). Invites now read
    -- the platform user directory instead, so nothing reads this table: no
    -- foreign keys point at it and it held only derived data.
    DROP TABLE IF EXISTS known_users;

    -- The default category is now the invisible "uncategorized" bucket.
    -- A renamed default was evidently being used as a real category, so it
    -- keeps its visible header by losing the flag (idempotent).
    UPDATE categories SET is_default = FALSE WHERE is_default AND name <> 'General';
  `);
  server = app.listen(port, () => console.log(`Listening on :${port}`));
}

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Containers are replaced on every deploy via SIGTERM: stop accepting
// connections, let in-flight requests finish inside a hard deadline, close the
// pool, exit. /health reports 503 from the moment we start draining.
// ---------------------------------------------------------------------------

const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent: SIGTERM then SIGINT must not double-run
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  // Live SSE subscribers would otherwise hold the process open for the whole
  // grace window.
  for (const listId of Array.from(listStreams.keys())) closeListStreams(listId);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
