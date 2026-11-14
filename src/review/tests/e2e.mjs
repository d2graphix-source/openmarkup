// End-to-end test in real Chromium. Two local servers stand in for production:
//
//   client site   http://127.0.0.1:<o>         a site with the OpenMarkup script in its <head>
//   app           http://app.localhost:<a>     serves the script and hosts the iframe and the ReviewHost controller
//
// Run:  node --experimental-strip-types src/review/tests/e2e.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Build the in-page scripts and the host into a temporary folder, the same way the real build does.
const here = dirname(fileURLToPath(import.meta.url));
const mod = resolve(here, '..');
const out = mkdtempSync(join(tmpdir(), 'review-e2e-'));
await build({ entryPoints: [join(mod, 'frame/widget.ts'), join(mod, 'frame/snap.ts')], bundle: true, format: 'iife', outdir: join(out, 'assets'), logLevel: 'error' });
await build({ entryPoints: [join(mod, 'frame/embed.ts')], bundle: true, format: 'iife', outfile: join(out, 'assets/openmarkup.js'), logLevel: 'error' });
await build({ entryPoints: [join(mod, 'host/reviewHost.ts'), join(mod, 'host/memoryStore.ts')], bundle: true, format: 'esm', outdir: join(out, 'dist/host'), logLevel: 'error' });
const root = out;

const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));

// ---------------------------------------------------------------- client site
const seen = { api: [] };
let O, APP; // origin, filled in once the port is known
const sitePage = (title, body, head = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<script src="${APP}/assets/openmarkup.js" async></script>
<style>
  body { font: 16px/1.4 sans-serif; margin: 0; }
  .wrap { padding: 24px; }
  .mover { width: 140px; padding: 12px; background: #fde68a; animation: slide 1.2s linear infinite alternate; }
  @keyframes slide { from { transform: translateX(0); } to { transform: translateX(260px); } }
  .tall { height: 1600px; }
</style>${head}</head><body>${body}</body></html>`;

const site = createServer((req, res) => {
  const url = new URL(req.url, O);
  const blockFraming = {};
  const html = (text) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...blockFraming });
    res.end(text);
  };
  if (url.pathname === '/api/ping') {
    seen.api.push({ host: req.headers.host, referer: req.headers.referer ?? null, via: url.searchParams.get('via') });
    res.writeHead(200, { 'content-type': 'application/json', ...blockFraming });
    return res.end(JSON.stringify({ pong: true, host: req.headers.host }));
  }
  if (url.pathname === '/x.png' || url.pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/gif', ...blockFraming });
    return res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: `${O}/about/` });
    return res.end();
  }
  if (url.pathname === '/about/') {
    return html(sitePage('About', `<div class="wrap"><h1>About us</h1><a id="home" href="${O}/">Home</a></div>`));
  }
  if (url.pathname === '/' || url.pathname === '/spa-route') {
    return html(
      sitePage(
        'Home',
        `<div class="wrap">
          <h1>Welcome to the client site</h1>
          <p id="lead">Lead paragraph with a stable id.</p>
          <section data-id="hero1"><p>Builder block identified by data-id.</p></section>
          <nav><a id="about" href="${O}/about/">About</a> <a id="redir" href="${O}/redirect">Redirecting link</a></nav>
          <button id="site-button" onclick="document.body.dataset.clicked='1'">Site button</button>
          <div class="mover">Moving box</div>
          <div id="api">waiting</div><div id="xhr">waiting</div>
          <div class="tall"></div>
        </div>
        <script>
          // Absolute URLs on the real origin, built at runtime: only the shim can catch these.
          fetch('${O}/api/ping?via=fetch').then(r => r.json()).then(j => { document.getElementById('api').textContent = 'fetch ok ' + j.host; })
            .catch(e => { document.getElementById('api').textContent = 'fetch failed ' + e; });
          var x = new XMLHttpRequest(); x.open('GET', '${O}/api/ping?via=xhr');
          x.onload = function () { document.getElementById('xhr').textContent = 'xhr ok ' + JSON.parse(x.responseText).host; };
          x.onerror = function () { document.getElementById('xhr').textContent = 'xhr failed'; };
          x.send();
        </script>`,
      ),
    );
  }
  res.writeHead(404, { 'content-type': 'text/plain', ...blockFraming });
  res.end('not found');
});
const sitePort = await listen(site);
O = `http://127.0.0.1:${sitePort}`;

// ---------------------------------------------------------------- app
const TYPES = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' };

const app = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    return res.end(`<!doctype html><meta charset="utf-8"><title>OpenMarkup harness</title>
<style>html,body{margin:0;height:100%}#stage{width:1100px;height:700px;overflow:auto}iframe{border:0;display:block}</style>
<div id="stage"><iframe id="f"></iframe></div>
<script type="module">
  import { ReviewHost } from '/dist/host/reviewHost.js';
  import { MemoryStore } from '/dist/host/memoryStore.js';
  const store = new MemoryStore();
  const log = { urls: [], missing: [], errors: [], threadPushes: 0 };
  const review = { store, log, ready: 0 };
  window.review = review;
  review.host = new ReviewHost({
    iframe: document.getElementById('f'),
    frameOrigin: ${JSON.stringify(O)},
    startPath: '/',
    store,
    user: { id: 'u1', name: 'Dana Reviewer', isGuest: false },
    canComment: true,
    onUrlChange: (info) => log.urls.push(info),
    onMissingAnchors: (ids) => log.missing.push(ids),
    onThreadsChange: () => log.threadPushes++,
    onReady: () => review.ready++,
    onError: (e, where) => log.errors.push(String(e) + ' @' + where),
  });
  await review.host.start();
</script>`);
  }
  const file = join(root, url.pathname);
  if (url.pathname.startsWith('/dist/') || url.pathname.startsWith('/assets/')) {
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      return res.end(readFileSync(file));
    }
  }
  res.writeHead(url.pathname === '/favicon.ico' ? 204 : 404);
  res.end();
});
const appPort = await listen(app);
APP = `http://app.localhost:${appPort}`;

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await context.newPage();
const requestedHosts = new Set();
context.on('request', (r) => { try { requestedHosts.add(new URL(r.url()).hostname); } catch { /* data: urls */ } });
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(error.message ?? error).split('\n').join('\n       ')}`);
  }
}
const store = () => page.evaluate(() => window.review.store.threads);
const log = () => page.evaluate(() => window.review.log);
const frame = async () => (await page.$('#f')).contentFrame();
const inFrame = page.frameLocator('#f');
const layer = inFrame.locator('openmarkup-layer');
const waitFor = async (fn, what, ms = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
};
const setMode = (mode) => page.evaluate((m) => window.review.host.setMode(m), mode);

console.log(`client site ${O}\napp         ${APP}\n`);

await step('the site loads with its script and completes the handshake', async () => {
  await page.goto(`${APP}/`);
  await waitFor(() => page.evaluate(() => window.review?.ready >= 1), 'frame:ready');
  await inFrame.locator('h1').waitFor();
  assert.equal(await inFrame.locator('h1').textContent(), 'Welcome to the client site');
  const sandbox = await page.getAttribute('#f', 'sandbox');
  assert.ok(!sandbox.includes('allow-top-navigation') && !sandbox.includes('allow-modals'));
});

await step('browse mode shows no review UI', async () => {
  assert.equal(await layer.evaluate((el) => getComputedStyle(el).display), 'none');
});

let firstThreadId;
await step('comment mode: clicking an element opens a composer and saves a thread', async () => {
  await setMode('comment');
  await inFrame.locator('h1').click({ position: { x: 60, y: 12 } });
  const textarea = layer.locator('textarea');
  await textarea.waitFor();
  await textarea.fill('First note on the heading');
  await layer.locator('button.primary').click();
  const threads = await waitFor(async () => { const t = await store(); return t.length === 1 && t; }, 'thread saved');
  const t = threads[0];
  firstThreadId = t.id;
  assert.equal(t.pageUrl, `${O}/`, 'stores the page URL');
  assert.equal(t.pageKey, '/');
  assert.equal(t.viewport, 'Desktop');
  assert.equal(t.anchor.tag, 'h1');
  assert.equal(t.anchor.text, 'Welcome to the client site');
  assert.ok(t.anchor.fx > 0 && t.anchor.fx < 1 && t.anchor.fy > 0 && t.anchor.fy < 1);
  assert.equal(t.comments[0].body, 'First note on the heading');
  assert.equal(t.comments[0].authorName, 'Dana Reviewer');
  await waitFor(async () => (await layer.locator('.pin:not(.pending)').count()) === 1, 'pin rendered');
  assert.equal(await layer.locator('.pin.pending').count(), 0, 'pending pin cleared');
});

// Where the pin's tip is, and where the anchor says it should be, in frame viewport pixels.
const pinError = async (threadId) => {
  const f = await frame();
  return f.evaluate(async ({ threadId }) => {
    const hostEl = document.querySelector('openmarkup-layer');
    const pin = hostEl.shadowRoot.querySelector(`.pin[data-thread-id="${threadId}"]`);
    const m = new DOMMatrix(getComputedStyle(pin).transform);
    return { x: m.m41, y: m.m42, cls: pin.className };
  }, { threadId });
};

await step('the pin sits on the clicked point of the element', async () => {
  const f = await frame();
  const t = (await store())[0];
  const expected = await f.evaluate((a) => {
    const r = document.querySelector('.wrap h1').getBoundingClientRect();
    return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
  }, t.anchor);
  const pin = await pinError(t.id);
  assert.ok(Math.abs(pin.x - expected.x) < 1.5 && Math.abs(pin.y - expected.y) < 1.5, JSON.stringify({ pin, expected }));
});

await step('comment mode: the page itself does not react to clicks', async () => {
  await inFrame.locator('#site-button').click();
  await layer.locator('textarea').waitFor();
  const f = await frame();
  assert.equal(await f.evaluate(() => document.body.dataset.clicked ?? null), null, "site's onclick must not fire");
  await page.keyboard.press('Escape');
  await waitFor(async () => (await layer.locator('textarea').count()) === 0, 'composer closed');
});

let moverThreadId;
await step('a pin on an animated element follows it frame by frame', async () => {
  // force: Playwright otherwise waits for the element to stop moving, which it never does.
  await inFrame.locator('.mover').click({ position: { x: 20, y: 10 }, force: true });
  await layer.locator('textarea').fill('On the moving box');
  await page.keyboard.press('Control+Enter');
  const threads = await waitFor(async () => { const t = await store(); return t.length === 2 && t; }, 'second thread');
  moverThreadId = threads[1].id;
  await waitFor(async () => (await layer.locator(`.pin[data-thread-id="${moverThreadId}"]`).count()) === 1, 'mover pin');
  const f = await frame();
  const samples = await f.evaluate(async ({ id, anchor }) => {
    const pin = document.querySelector('openmarkup-layer').shadowRoot.querySelector(`.pin[data-thread-id="${id}"]`);
    const el = document.querySelector('.mover');
    const out = [];
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const rect = el.getBoundingClientRect();
      const m = new DOMMatrix(pin.style.transform);
      out.push({ elX: rect.left, err: Math.hypot(m.m41 - (rect.left + anchor.fx * rect.width), m.m42 - (rect.top + anchor.fy * rect.height)) });
    }
    return out;
  }, { id: moverThreadId, anchor: threads[1].anchor });
  const travel = Math.max(...samples.map((s) => s.elX)) - Math.min(...samples.map((s) => s.elX));
  const worst = Math.max(...samples.map((s) => s.err));
  assert.ok(travel > 40, `element should actually be moving (travelled ${travel.toFixed(1)}px)`);
  // One frame of lag at this speed is about 7px; allow that, since rAF callback order is not guaranteed.
  assert.ok(worst < 9, `pin drifted ${worst.toFixed(1)}px from the element while it travelled ${travel.toFixed(1)}px`);
  console.log(`         (element travelled ${travel.toFixed(0)}px over 45 frames; worst pin error ${worst.toFixed(2)}px)`);
});

await step('a pin survives new content being inserted above its element', async () => {
  const f = await frame();
  const before = await pinError(firstThreadId);
  // Shift the structure: the old positional path now points at something else.
  await f.evaluate(() => {
    const banner = document.createElement('div');
    banner.innerHTML = '<h1 style="margin:0;font-size:14px">Cookie banner inserted later</h1>';
    banner.style.cssText = 'height:70px;background:#eee';
    document.body.prepend(banner);
  });
  await waitFor(async () => (await pinError(firstThreadId)).y > before.y + 60, 'pin moved down with its element');
  // Once anchors are re-resolved, the pin should be flagged as found by a fallback, not by its original selector.
  await waitFor(async () => /approx/.test((await pinError(firstThreadId)).cls), 'pin marked approximate');
  const t = (await store())[0];
  const expected = await f.evaluate((a) => {
    const r = document.querySelector('.wrap h1').getBoundingClientRect();
    return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height, pathHit: document.querySelector(a.path)?.localName ?? null };
  }, t.anchor);
  const pin = await pinError(firstThreadId);
  assert.ok(Math.abs(pin.x - expected.x) < 1.5 && Math.abs(pin.y - expected.y) < 1.5, JSON.stringify({ pin, expected }));
  console.log(`         (stored path now resolves to: ${expected.pathHit}; pin classes: "${pin.cls}")`);
});

await step('browse mode: links navigate inside the frame and the host learns the real URL', async () => {
  await setMode('browse');
  await inFrame.locator('#about').click();
  await inFrame.locator('h1', { hasText: 'About us' }).waitFor();
  const f = await frame();
  assert.equal(f.url(), `${O}/about/`);
  const urls = (await log()).urls;
  assert.deepEqual({ pageUrl: urls.at(-1).pageUrl, pageKey: urls.at(-1).pageKey, title: urls.at(-1).title }, { pageUrl: `${O}/about/`, pageKey: '/about', title: 'About' });
  await waitFor(() => page.evaluate(() => window.review.ready >= 2), 'handshake repeated after navigation');
});

await step('pins only appear on the page they belong to', async () => {
  await setMode('comment');
  await page.waitForTimeout(150);
  assert.equal(await layer.locator('.pin').count(), 0);
});

await step('redirects are followed inside the frame', async () => {
  await setMode('browse');
  await inFrame.locator('#home').click();
  await inFrame.locator('#redir').click();
  await inFrame.locator('h1', { hasText: 'About us' }).waitFor();
  assert.equal((await frame()).url(), `${O}/about/`);
});

await step('focusing a thread from the sidebar navigates to its page and opens it', async () => {
  await page.evaluate((id) => window.review.host.focusThread(id), firstThreadId);
  await inFrame.locator('h1', { hasText: 'Welcome' }).waitFor();
  await layer.locator('.panel .comment .body').waitFor();
  assert.equal(await layer.locator('.panel .comment .body').first().textContent(), 'First note on the heading');
  assert.equal(await page.evaluate(() => window.review.host.getMode()), 'comment');
});

await step('reply and resolve from the thread popover reach the store', async () => {
  await layer.locator('.panel textarea').fill('A reply');
  await layer.locator('.panel button.primary').click();
  await waitFor(async () => (await store())[0].comments.length === 2, 'reply saved');
  await waitFor(async () => (await layer.locator('.panel .comment').count()) === 2, 'reply shown');
  await layer.locator('.panel header button').click();
  await waitFor(async () => (await store())[0].resolved === true, 'resolved saved');
  await waitFor(async () => (await layer.locator(`.pin.resolved[data-thread-id="${firstThreadId}"]`).count()) === 1, 'pin shows resolved');
  await page.keyboard.press('Escape');
});

await step('comment text is rendered as text, never as markup', async () => {
  await inFrame.locator('#lead').click({ position: { x: 30, y: 8 } });
  await layer.locator('textarea').fill('<img src=x onerror="window.__xss=1"><b>bold</b>');
  await page.keyboard.press('Control+Enter');
  const threads = await waitFor(async () => { const t = await store(); return t.length === 3 && t; }, 'third thread');
  await layer.locator(`.pin[data-thread-id="${threads[2].id}"]`).click();
  await layer.locator('.panel .comment .body').waitFor();
  assert.equal(await layer.locator('.panel .comment .body').textContent(), '<img src=x onerror="window.__xss=1"><b>bold</b>');
  assert.equal(await layer.locator('.panel img, .panel b').count(), 0);
  const f = await frame();
  assert.equal(await f.evaluate(() => window.__xss ?? null), null);
  assert.equal(threads[2].anchor.selector, '#lead', 'stable id preferred as the selector');
  await page.keyboard.press('Escape');
});

await step('builder data-id is preferred over a positional path', async () => {
  await inFrame.locator('[data-id="hero1"] p').click({ position: { x: 20, y: 6 } });
  await layer.locator('textarea').fill('On the builder block');
  await page.keyboard.press('Control+Enter');
  const threads = await waitFor(async () => { const t = await store(); return t.length === 4 && t; }, 'fourth thread');
  assert.equal(threads[3].anchor.selector, 'section[data-id="hero1"] > p');
});

await step('changes from another reviewer appear without a reload', async () => {
  const before = await layer.locator('.pin').count();
  await page.evaluate(() => {
    const { store } = window.review;
    const copy = structuredClone(store.threads[0]);
    copy.id = 'remote-1';
    copy.resolved = false;
    copy.anchor = { ...copy.anchor, fx: 0.9 };
    copy.comments = [{ id: 'rc1', authorId: 'u2', authorName: 'Someone else', body: 'Remote comment', createdAt: new Date().toISOString() }];
    store.threads.push(copy);
    store.emitRemoteChange();
  });
  await waitFor(async () => (await layer.locator('.pin').count()) === before + 1, 'remote pin');
});

await step('messages from the wrong origin are ignored by the host', async () => {
  const count = (await store()).length;
  await page.evaluate((id) => window.postMessage({ channel: 'openmarkup', type: 'thread:delete', threadId: id }, '*'), firstThreadId);
  await page.waitForTimeout(200);
  assert.equal((await store()).length, count);
});

await step('messages from the wrong origin are ignored by the frame', async () => {
  const f = await frame();
  // The page posts to itself: origin is the site, not the app, and source is not the parent.
  await f.evaluate(() => window.postMessage({ channel: 'openmarkup', type: 'host:mode', mode: 'browse' }, '*'));
  await page.waitForTimeout(200);
  assert.equal(await layer.evaluate((el) => getComputedStyle(el).display), 'block', 'still in comment mode');
});

await step('read-only reviewers can open threads but cannot comment', async () => {
  await page.evaluate(() => window.review.host.setCanComment(false));
  await inFrame.locator('h1').click({ position: { x: 200, y: 12 } });
  await page.waitForTimeout(200);
  assert.equal(await layer.locator('textarea').count(), 0, 'no composer');
  await layer.locator(`.pin[data-thread-id="${firstThreadId}"]`).click();
  await layer.locator('.panel .comment').first().waitFor();
  assert.equal(await layer.locator('.panel textarea').count(), 0, 'no reply box');
  assert.equal(await layer.locator('.panel header button').count(), 0, 'no resolve button');
  await page.keyboard.press('Escape');
  // And the host refuses writes even if a frame asked anyway.
  const count = (await store()).length;
  const f = await frame();
  await f.evaluate((app) => window.parent.postMessage({ channel: 'openmarkup', type: 'thread:delete', threadId: 'remote-1' }, app), APP);
  await page.waitForTimeout(200);
  assert.equal((await store()).length, count, 'host enforces read-only');
  await page.evaluate(() => window.review.host.setCanComment(true));
});

await step('single-page route changes are reported', async () => {
  const f = await frame();
  await f.evaluate(() => history.pushState({}, '', '/spa-route'));
  await waitFor(async () => (await log()).urls.at(-1).pageKey === '/spa-route', 'spa url');
  assert.equal((await log()).urls.at(-1).pageUrl, `${O}/spa-route`);
  assert.equal(await layer.locator('.pin').count(), 0, 'pins for "/" hidden on the new route');
  await f.evaluate(() => history.back());
  await waitFor(async () => (await layer.locator('.pin').count()) >= 4, 'pins return');
});

await step('viewport presets resize the frame and scope the threads', async () => {
  await page.evaluate(() => window.review.host.setViewport('Phone'));
  await waitFor(async () => (await layer.locator('.pin').count()) === 0, 'desktop pins hidden in Phone');
  assert.equal(await page.evaluate(() => document.getElementById('f').getBoundingClientRect().width), 390);
  const f = await frame();
  assert.equal(await f.evaluate(() => window.innerWidth), 390);
  await inFrame.locator('h1').click({ position: { x: 20, y: 10 } });
  await layer.locator('textarea').fill('Phone-only note');
  await page.keyboard.press('Control+Enter');
  await waitFor(async () => (await store()).some((t) => t.viewport === 'Phone'), 'phone thread saved');
  await waitFor(async () => (await layer.locator('.pin:not(.pending)').count()) === 1, 'one phone pin');
  await page.evaluate(() => window.review.host.setViewport('Desktop'));
  await waitFor(async () => (await layer.locator('.pin').count()) >= 4, 'desktop pins back');
});

await step('edited copy keeps its pin when the selector is stable, marked approximate', async () => {
  const lead = (await store()).find((t) => t.anchor.selector === '#lead');
  const f = await frame();
  await f.evaluate(() => { document.getElementById('lead').textContent = 'Completely rewritten copy.'; });
  await waitFor(async () => /approx/.test((await pinError(lead.id)).cls), 'pin marked approximate');
  const expected = await f.evaluate((a) => {
    const r = document.getElementById('lead').getBoundingClientRect();
    return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height };
  }, lead.anchor);
  const pin = await pinError(lead.id);
  assert.ok(Math.abs(pin.x - expected.x) < 1.5 && Math.abs(pin.y - expected.y) < 1.5, JSON.stringify({ pin, expected }));
  assert.ok(!(await log()).missing.at(-1)?.includes(lead.id), 'not reported missing');
});

await step('when the pinned element is removed, the host is told and the pin is marked', async () => {
  const f = await frame();
  await f.evaluate(() => document.querySelector('.mover').remove());
  await waitFor(async () => (await log()).missing.at(-1)?.includes(moverThreadId), 'anchors:missing');
  assert.match((await pinError(moverThreadId)).cls, /detached/);
});

await step('no errors were raised along the way', async () => {
  assert.deepEqual((await log()).errors, []);
  // A blocked-frame console error from the control step is expected; anything else is not.
  const unexpected = consoleErrors.filter((e) => !/X-Frame-Options|frame-ancestors|Refused to (display|frame)/i.test(e));
  assert.deepEqual(unexpected, []);
});

await step('the browser only ever talked to the two servers under test (nothing phones home)', async () => {
  const allowed = (h) => h === '127.0.0.1' || h === 'app.localhost' || h === '';
  assert.deepEqual([...requestedHosts].filter((h) => !allowed(h)), []);
});

await browser.close();
for (const server of [site, app]) server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
