// The one HTTP server: Twilio webhooks + call audio, view-only trip pages, the projector view, reset.
// Routes: CONTRACTS.md section 7. Anything not listed there gets the same "Not found" page.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { bus } from './events.js';
import { store, findOrder, findMember } from './store.js';
import { createTwilio, isLocal, safeEqual } from './twilio.js';
import { createMessages } from './messages.js';
import { createPayment } from './payment.js';
import { createKnowledge, loadPassages } from './knowledge.js';

const RECENT_MAX = 200;
// Trip pages are private to whoever holds the link: never indexed, never cached, no referrer sent on.
const PRIVATE = { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const html = (res, status, body) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE }).end(body);
const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const isAdmin = (key) => safeEqual(key, config.adminSecret);

/**
 * @param {object} deps  { tools: { specs, runTool }, startSession, renderTripPage, notFoundPage,
 *                         projectorHtml, handleMockCathay, messages, payment }
 * @returns {import('node:http').Server}
 */
export function createApp(deps) {
  const { tools, startSession, renderTripPage, notFoundPage, projectorHtml, handleMockCathay, payment } = deps;
  const phoneLine = createTwilio({ tools, startSession, payment });
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

  function tripPage(code, res) {
    const page = store.pages.get(code);
    if (!page || (page.expires != null && Date.now() > new Date(page.expires).getTime())) return notFound(res);
    const order = page.ref ? findOrder(page.ref) : null;
    html(res, 200, renderTripPage({ page, order, profile: findMember(page.member_id), now: Date.now() }));
  }

  async function route(req, res) {
    const [path, query] = req.url.split('?');
    const is = (method, p) => req.method === method && path === p;

    if (is('POST', '/twilio/voice')) return phoneLine.voice(req, res);
    if (is('POST', '/twilio/sms')) return phoneLine.sms(req, res);
    if (req.method === 'GET' && path.startsWith('/v/')) return tripPage(path.slice(3), res);
    if (path.startsWith('/pay/')) return payment.payRoute(req, res, path.slice(5), () => notFound(res));
    if (is('GET', '/projector') && isAdmin(new URLSearchParams(query).get('key'))) return html(res, 200, projectorHtml);
    if (is('POST', '/reset') && isAdmin(req.headers['x-admin-key'])) {
      phoneLine.endCall();
      store.reset();
      return json(res, 200, { ok: true });
    }
    if (is('POST', '/dev/simulate') && isAdmin(req.headers['x-admin-key'])) {
      const call = await phoneLine.simulate();
      return call ? json(res, 200, { ok: true, call_id: call.id }) : json(res, 409, { ok: false, error: 'a call is already live; POST /reset first' });
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
    if (path === '/twilio/stream') return wss.handleUpgrade(req, socket, head, phoneLine.stream);
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
  const payment = createPayment({ messages, texts, baseUrl: config.baseUrl });
  // One adapter per call, so projector lines carry the call id. The mock Cathay systems answer only on this
  // machine, so the adapter uses the local address, not the public one.
  const cathay = (callId) => createCathay({ base: `http://127.0.0.1:${app.address().port}`, callId });
  const knowledge = createKnowledge({ passages: loadPassages(), mode: config.knowledge });
  const tools = createTools({ cathay, messages, texts, emails, knowledge, baseUrl: config.baseUrl });
  const app = createApp({
    tools, startSession: model.startSession, renderTripPage: trip.renderTripPage, notFoundPage: trip.notFoundPage,
    projectorHtml: readFileSync(new URL('./screens/projector.html', import.meta.url), 'utf8'),
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
