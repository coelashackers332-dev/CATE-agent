// The projector page has no build step and no modules, so its one inline script runs here against
// a small stand-in for the browser: enough to feed it call events and press keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/screens/projector.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function element(hidden = false) {
  const classes = new Set(), loads = [];
  return {
    children: [], textContent: '', className: '', hidden, style: {}, scrollTop: 0, scrollHeight: 0, clientWidth: 0, clientHeight: 0, loads,
    get src() { return loads.at(-1) ?? ''; },
    set src(v) { loads.push(v); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children = []; },
    addEventListener() {},
    classList: { toggle: (c) => (classes.delete(c) ? false : !!classes.add(c)), contains: (c) => classes.has(c) },
  };
}

/** Load the page: every element that has an id in the markup exists, and nothing else does. */
function boot() {
  const els = Object.fromEntries([...html.matchAll(/<\w+[^>]*\sid="([\w-]+)"[^>]*>/g)].map(([tag, id]) => [id, element(/\shidden\b/.test(tag))]));
  const body = element(), sockets = [], on = {};
  vm.runInNewContext(script, {
    document: { getElementById: (id) => els[id] ?? null, createElement: () => element(), body },
    location: { search: '?key=k', protocol: 'http:', host: 'localhost:8080', href: 'http://localhost:8080/projector?key=k' },
    URL, URLSearchParams,
    WebSocket: class { constructor() { sockets.push(this); } close() {} },
    fetch: async () => ({ ok: true }),
    setTimeout() {},
    addEventListener: (type, fn) => { on[type] = fn; },
  });
  return {
    els, body,
    send: (ev) => sockets[0].onmessage({ data: JSON.stringify(ev) }),
    press: (key) => on.keydown({ key }),
    /** The address the phone on the right shows, or null while it shows nothing. */
    phone: () => (els.phone && !els.phone.hidden ? els.phone.src : null),
  };
}

const texted = (url) => ({ kind: 'screen', call_id: 'c1', what: 'options_page', summary: 'trip page created', url });
const booking = (status) => ({ kind: 'state', call_id: null, ref: 'K7Q2XM', status });
const reset = { kind: 'system', call_id: null, system: 'Demo', action: 'reset', ok: true, summary: 'demo data reset' };

test('the phone stays empty until CATE texts the link, then opens the trip page from this server', () => {
  const p = boot();
  p.send({ kind: 'cate_said', call_id: 'c1', text: 'Where would you like to go?' });
  assert.equal(p.phone(), null);
  assert.equal(p.els.idle?.hidden, false, 'the "nothing yet" line shows');

  p.send(texted('https://cate-demo.example.com/v/AbC-123_x'));
  assert.equal(p.phone(), '/v/AbC-123_x', 'only the path: the page always comes from the server the projector is on');
  assert.equal(p.els.idle.hidden, true);
});

test('only a trip page goes in the phone, whatever address an event carries', () => {
  const p = boot();
  p.send(texted('http://localhost:8080/v/good'));
  for (const url of ['https://evil.example.com/login', 'javascript:alert(1)', '//evil.example.com/v/../x', '/projector?key=k', '/v/', '/v/a/b', '', undefined]) {
    p.send(texted(url));
    assert.equal(p.phone(), '/v/good', `${url} must not replace the trip page`);
  }
});

test('a booking change reloads the phone at once', () => {
  const p = boot();
  p.send(texted('http://localhost:8080/v/good'));
  p.send(booking('held'));
  assert.deepEqual(p.els.phone?.loads, ['/v/good', '/v/good']);
});

test('reset empties the phone, and it stays empty', () => {
  const p = boot();
  p.send(texted('http://localhost:8080/v/good'));
  assert.equal(p.phone(), '/v/good');
  p.send(reset);
  assert.equal(p.phone(), null);
  assert.equal(p.els.phone.src, 'about:blank', 'the old trip page is unloaded, not only hidden');
  assert.equal(p.els.idle.hidden, false);
  p.send(booking('paid'));
  assert.equal(p.els.phone.src, 'about:blank');
});

test('T swaps the phone for the systems log, and back', () => {
  const p = boot();
  assert.equal(p.body.classList.contains('tech'), false, 'the room sees the phone first');
  p.press('t');
  assert.equal(p.body.classList.contains('tech'), true);
  p.press('T');
  assert.equal(p.body.classList.contains('tech'), false);
});

test('a flight chosen by voice or by tap shows on the phone at once; a refused answer changes nothing', () => {
  const p = boot();
  p.send(texted('http://localhost:8080/v/good'));
  const result = (name, ok) => p.send({ kind: 'tool_result', call_id: 'c1', name, result: ok ? { ok: true } : { ok: false, error: 'no' } });
  result('choose_option', true);
  assert.deepEqual(p.els.phone.loads, ['/v/good', '/v/good'], 'reloaded for the choice');
  result('choose_option', false);
  result('set_assistance', true);
  assert.equal(p.els.phone.loads.length, 2, 'no reload for a refused choice or an answer the page does not show');
});
