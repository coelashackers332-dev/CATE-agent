// The phone line: the local audio socket that Max's Bluetooth bridge connects to (WS /local/stream, CONTRACTS.md §7).
// Also owns the life of a call: create the call context, start the model session, end both.
// Audio is PCM16 little-endian, 8 kHz mono, both ways, as binary WebSocket frames: no codec, no conversion.
import { emit } from './events.js';
import { store, findMember } from './store.js';

let callSeq = 0;

/** A binary frame → Int16Array. Copied, because a Buffer's offset may not be 2-byte aligned; an odd last byte is dropped. */
function toPcm(buf) {
  const pcm = new Int16Array(buf.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
  return pcm;
}

const fromPcm = (pcm) => {
  const bytes = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2);
  return bytes;
};

export function createPhone({ tools, startSession }) {
  let socket = null;    // the live call's bridge socket

  // Call context, CONTRACTS.md section 2.
  function newCall(callerId) {
    store.activeCall = {
      id: `c${++callSeq}`, callerId, memberId: null, token: null, verified: false, options: [],
      pageCode: null, pendingHold: null, assistance: null, ref: null, session: null,
    };
    return store.activeCall;
  }

  /** End a call: close the model session, free the line, hang up. Safe to call twice. */
  function endCall(call = store.activeCall) {
    if (!call) return;
    try { call.session?.close(); } catch (err) { console.error(`[call ${call.id}] session close failed: ${err.message}`); }
    call.session = null;
    if (store.activeCall !== call) return;
    store.activeCall = null;
    emit(call.id, 'system', { system: 'Phone', action: 'call ended', ok: true, summary: 'call ended' });
    const ws = socket;
    socket = null;
    ws?.close();   // the bridge hangs up the phone when its socket closes
  }

  async function begin(call, sendAudio, onInterrupt) {
    const session = await startSession({ call, specs: tools.specs, runTool: tools.runTool, sendAudio, onInterrupt, emit });
    if (store.activeCall !== call) { session?.close(); return; }   // the caller hung up while the model was starting
    call.session = session;
    emit(call.id, 'system', { system: 'Phone', action: 'call started', ok: true, summary: 'call connected' });
  }

  /**
   * WS /local/stream: the bridge sends {"event":"start"} when the standby phone answers, then the caller's audio.
   * Bluetooth gives the laptop no caller ID, so the call is from the demo member's number (as with /dev/simulate).
   */
  function local(ws) {
    let call = null;
    const say = (event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event })); };

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return call?.session?.audioIn(toPcm(raw));
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.event !== 'start' || call) return;
      if (store.activeCall) { say('busy'); return ws.close(); }
      call = newCall(findMember('DEMO-0001').phone);
      socket = ws;
      begin(
        call,
        (pcm) => { if (ws.readyState === ws.OPEN) ws.send(fromPcm(pcm)); },
        () => say('clear'),   // the caller talked over CATE: the bridge drops the audio it has not played yet
      ).catch((err) => {
        console.error(`[call ${call.id}] model session failed to start: ${err.message}`);
        endCall(call);
      });
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => endCall(call));
  }

  /** POST /dev/simulate: a call from the demo member's number with no phone attached. Returns null if the line is busy. */
  async function simulate() {
    if (store.activeCall) return null;
    const call = newCall(findMember('DEMO-0001').phone);
    try {
      await begin(call, () => {}, () => {});
    } catch (err) {
      endCall(call);
      throw err;
    }
    return call;
  }

  return { local, simulate, endCall };
}
