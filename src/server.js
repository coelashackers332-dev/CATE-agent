// The one HTTP server: the local phone line (call audio), view-only trip pages, the projector view, reset.
// Routes: CONTRACTS.md section 7. Anything not listed there gets the same "Not found" page.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { bus } from './events.js';
import { store, findOrder, findMember } from './store.js';
import { createPhone } from './phone.js';
import { createMessages } from './messages.js';
import { createPayment } from './payment.js';
import { createKnowledge, loadPassages } from './knowledge.js';

const RECENT_MAX = 200;
// Trip pages are private to whoever holds the link: never indexed, never cached, no referrer sent on.
const PRIVATE = { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const html = (res, status, body) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE }).end(body);
const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const sha = (v) => createHash('sha256').update(String(v ?? '')).digest();
/** Compare two secrets without leaking where they differ. */
export const safeEqual = (a, b) => Boolean(a) && Boolean(b) && timingSafeEqual(sha(a), sha(b));
const isAdmin = (key) => safeEqual(key, config.adminSecret);

/** True only for a request made on this machine and not passed on by a tunnel or proxy (those add X-Forwarded-For). */
export function isLocal(req) {
  const ip = req.socket.remoteAddress ?? '';
  return (ip === '::1' || ip.replace(/^::ffff:/, '').startsWith('127.')) && !req.headers['x-forwarded-for'];
}

/**
 * @param {object} deps  { tools: { specs, runTool }, startSession, renderTripPage, notFoundPage,
 *                         projectorHtml, bridgeHtml, handleMockCathay, messages, payment }
 * @returns {import('node:http').Server}
 */
export function createApp(deps) {
  const { tools, startSession, renderTripPage, notFoundPage, projectorHtml, bridgeHtml, handleMockCathay, payment } = deps;
  const phoneLine = createPhone({ tools, startSession });
  const notFound = (res) => html(res, 404, notFoundPage());

  // Projector feed: the last events for a view that connects late, then every new event as it happens.
  const recent = [];
  const viewers = new Set();
  const onEvent = (ev) => {
    if (ev.kind === 'system' && ev.system === 'Demo' && ev.action === 'reset') recent.length = 0;
    recent.push(ev);
    if (recent.length > RECENT_MAX) recent.shift();
    const line = JSON.stringify(ev);
    for (const ws of viewers) if (ws.readyState === ws.OPEN) ws.send(line);
  };
  bus.on('event', onEvent);

  const livePage = (code) => {
    const page = store.pages.get(code);
    return Boolean(page) && !(page.expires != null && Date.now() > new Date(page.expires).getTime());
  };
  // The live call that owns this trip page, while it is verified and nothing is held yet; otherwise null.
  const askingCall = (code) => {
    const call = store.activeCall;
    return call && call.pageCode === code && call.verified && !call.ref ? call : null;
  };

  function tripPage(code, res) {
    if (!livePage(code)) return notFound(res);
    const page = store.pages.get(code);
    const order = page.ref ? findOrder(page.ref) : null;
    const profile = findMember(page.member_id);
    // PAYMENT=page: the member pays for himself. While his booking is held, his trip page IS the pay page: an open
    // page (it checks every few seconds during the call) goes there by itself. Once paid, the trip page shows the booking.
    const payUrl = config.payment === 'page' ? `/pay/${code}` : null;
    if (payUrl && order?.status === 'held') return res.writeHead(303, { Location: payUrl, ...PRIVATE }).end();
    // While his call is live, the page also takes his flight choice by button. No "who pays" buttons: family: ''.
    const call = askingCall(code);
    const live = call ? { choice: call.choice ?? null, payer: null, family: '' } : null;
    html(res, 200, renderTripPage({ page, order, profile, now: Date.now(), payUrl, live }));
  }

  /** POST /v/:code: an answer button on the trip page (option=<id>), run as the same tool the call uses. */
  // Without a live call that is still asking, the page is read-only: the same 404 as an unknown code.
  async function tripAnswer(req, res, code) {
    const call = livePage(code) ? askingCall(code) : null;
    if (!call) return notFound(res);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2048) return res.writeHead(413, { Connection: 'close' }).end();
    }
    const form = new URLSearchParams(body);
    const option = form.get('option');
    // The model is told what was pressed, so the call and the page stay one conversation.
    if (option && call.options.some((o) => String(o.id) === option)) {
      const r = await tools.runTool('choose_option', { option_id: option }, call);
      if (r.ok) call.session?.notify?.(`He just chose flight ${option} with the button on his trip page. ${r.confirm ?? ''} Say that back to him and go on.`);
    }
    res.writeHead(303, { Location: `/v/${code}`, ...PRIVATE }).end();
  }

  async function route(req, res) {
    const [path, query] = req.url.split('?');
    const is = (method, p) => req.method === method && path === p;

    if (req.method === 'GET' && path.startsWith('/v/')) return tripPage(path.slice(3), res);
    if (req.method === 'POST' && path.startsWith('/v/')) return tripAnswer(req, res, path.slice(3));
    if (path.startsWith('/pay/')) return payment.payRoute(req, res, path.slice(5), () => notFound(res));
    if (is('GET', '/projector') && isAdmin(new URLSearchParams(query).get('key'))) return html(res, 200, projectorHtml);
    // The bridge page for the laptop phone line. The line has no caller ID, so it answers on this machine only, never through the tunnel.
    if (is('GET', '/bridge') && isLocal(req) && isAdmin(new URLSearchParams(query).get('key'))) return html(res, 200, bridgeHtml);
    if (is('POST', '/reset') && isAdmin(req.headers['x-admin-key'])) {
      phoneLine.endCall();
      store.reset();
      return json(res, 200, { ok: true });
    }
    if (is('POST', '/dev/simulate') && isAdmin(req.headers['x-admin-key'])) {
      const call = await phoneLine.simulate();
      return call ? json(res, 200, { ok: true, call_id: call.id }) : json(res, 409, { ok: false, error: 'a call is already live; POST /reset first' });
    }
    // Daniel pays: on stage, the operator presses this when Daniel acts on the pay request (there is no SMS reply line).
    if (is('POST', '/dev/pay') && isAdmin(req.headers['x-admin-key'])) {
      const order = store.orders.findLast((o) => o.status === 'held');
      if (!order) return json(res, 409, { ok: false, error: 'no booking is waiting for payment' });
      await payment.onPaid(order.ref, 'demo');
      return json(res, 200, { ok: true, ref: order.ref });
    }
    if (path.startsWith('/mock-cathay/') && isLocal(req) && await handleMockCathay(req, res)) return;
    notFound(res);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(`[server] ${req.method} ${req.url.split('?')[0]} failed:`, err);
      if (res.headersSent) res.end();
      else res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Server error');
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const [path, query] = req.url.split('?');
    // The audio bridge (the /bridge page) runs on this laptop: local only, plus the admin key.
    if (path === '/local/stream' && isLocal(req) && isAdmin(new URLSearchParams(query).get('key'))) {
      return wss.handleUpgrade(req, socket, head, phoneLine.local);
    }
    if (path === '/events' && isAdmin(new URLSearchParams(query).get('key'))) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        for (const ev of recent) ws.send(JSON.stringify(ev));
        viewers.add(ws);
        ws.on('close', () => viewers.delete(ws));
        ws.on('error', () => ws.terminate());
      });
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => bus.off('event', onEvent));
  return server;
}

/** Wire the real modules into one app. `port` is read when a call starts, so it works with listen(0) in tests. */
export async function wireApp() {
  const [{ createTools }, { createCathay }, { handleMockCathay }, trip, texts, emails, model] = await Promise.all([
    import('./tools.js'), import('./cathay.js'), import('./mock-cathay/routes.js'),
    import('./screens/trip.js'), import('./screens/texts.js'), import('./screens/emails.js'),
    import(`./model/${config.model}.js`),
  ]);
  const messages = createMessages({ mode: config.messages });
  const payment = createPayment({ messages, texts, emails, baseUrl: config.baseUrl });
  // One adapter per call, so projector lines carry the call id. The mock Cathay systems answer only on this
  // machine, so the adapter uses the local address, not the public one.
  const cathay = (callId) => createCathay({ base: `http://127.0.0.1:${app.address().port}`, callId });
  const knowledge = createKnowledge({ passages: loadPassages(), mode: config.knowledge });
  const tools = createTools({ cathay, messages, texts, knowledge, baseUrl: config.baseUrl });
  const app = createApp({
    tools, startSession: model.startSession, renderTripPage: trip.renderTripPage, notFoundPage: trip.notFoundPage,
    projectorHtml: readFileSync(new URL('./screens/projector.html', import.meta.url), 'utf8'),
    bridgeHtml: readFileSync(new URL('./screens/bridge.html', import.meta.url), 'utf8'),
    handleMockCathay, messages, payment,
  });
  return app;
}

// `node src/server.js`: wire the real modules and listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A failed promise in one call must not take the demo down.
  process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));
  store.reset();   // start this run's log file
  (await wireApp()).listen(config.port, () => {
    console.log(`CATE is listening on port ${config.port} (model: ${config.model}, messages: ${config.messages})`);
    console.log(`Projector: ${config.baseUrl}/projector?key=${encodeURIComponent(config.adminSecret)}`);
  });
}
