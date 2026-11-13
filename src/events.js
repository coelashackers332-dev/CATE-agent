// One bus for call events. The projector view subscribes; each run is also written to logs/<time>.jsonl.
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';

export const KINDS = ['caller_said', 'cate_said', 'tool_call', 'tool_result', 'system', 'screen', 'state'];

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const logDir = new URL('../logs/', import.meta.url);
let logFile = null;

function hkTime() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
}

/** Start a new log file (called by store.reset()). Tests pass `false` to disable file logging. */
export function newLog(enabled = true) {
  if (!enabled) { logFile = null; return; }
  mkdirSync(logDir, { recursive: true });
  logFile = new URL(new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl', logDir);
}

/**
 * Emit one call event.
 * @param {string|null} callId  call id, or null for events outside a call (reset, payment webhook)
 * @param {string} kind         one of KINDS
 * @param {object} fields       e.g. { text } | { name, args } | { name, result } | { system, action, ok, summary }
 */
export function emit(callId, kind, fields = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown event kind: ${kind}`);
  const ev = { t: hkTime(), call_id: callId, kind, ...fields };
  bus.emit('event', ev);
  if (logFile) {
    try { appendFileSync(logFile, JSON.stringify(ev) + '\n'); } catch { /* logging must never break a call */ }
  }
  return ev;
}
