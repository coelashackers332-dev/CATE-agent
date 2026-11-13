// The phone line: Twilio's voice webhook, the call audio WebSocket (Media Streams) and the SMS webhook.
// Also owns the life of a call: create the call context, start the model session, end both.
import { createHash, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { config } from './config.js';
import { emit } from './events.js';
import { store, newToken, findMember } from './store.js';
import { decode, encode } from './mulaw.js';

const { VoiceResponse, MessagingResponse } = twilio.twiml;
const FRAME = 160;              // 20 ms of 8 kHz μ-law
const STREAM_WAIT_MS = 15_000;  // Twilio must open the audio stream this soon after the webhook
const START_WAIT_MS = 5_000;    // and a stream must send a valid `start` this soon after connecting
const MAX_BODY = 64 * 1024;

const sha = (v) => createHash('sha256').update(String(v ?? '')).digest();
/** Compare two secrets without leaking where they differ. */
export const safeEqual = (a, b) => Boolean(a) && Boolean(b) && timingSafeEqual(sha(a), sha(b));

/** True only for a request made on this machine and not passed on by a tunnel or proxy (those add X-Forwarded-For). */
export function isLocal(req) {
  const ip = req.socket.remoteAddress ?? '';
  return (ip === '::1' || ip.replace(/^::ffff:/, '').startsWith('127.')) && !req.headers['x-forwarded-for'];
}

const phone = (n) => String(n ?? '').replace(/[^\d+]/g, '');   // "+852 0000 0001" and "+85200000001" match
const samePhone = (a, b) => phone(a) !== '' && phone(a) === phone(b);

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

let warned = false;
function signatureOk(req, params) {
  const { authToken } = config.twilio;
  if (!authToken) {
    if (!isLocal(req)) return false;
    if (!warned) console.warn('[twilio] TWILIO_AUTH_TOKEN is empty: signature check skipped for requests from this machine only');
    warned = true;
    return true;
  }
  const signature = req.headers['x-twilio-signature'];
  return typeof signature === 'string' && twilio.validateRequest(authToken, signature, config.baseUrl + req.url, params);
}

/** Read a Twilio webhook's form body and check its signature. Answers 403 itself and returns null on failure. */
async function signedForm(req, res) {
  const params = await readForm(req);
  if (params && signatureOk(req, params)) return params;
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
  return null;
}

const xml = (res, twiml) => res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' }).end(twiml.toString());

let callSeq = 0;

export function createTwilio({ tools, startSession, payment }) {
  let pending = null;   // { token, call, timer }: an accepted call whose audio stream has not started yet
  let socket = null;    // the live call's Twilio stream

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
    if (pending?.call === call) { clearTimeout(pending.timer); pending = null; }
    try { call.session?.close(); } catch (err) { console.error(`[call ${call.id}] session close failed: ${err.message}`); }
    call.session = null;
    if (store.activeCall !== call) return;
    store.activeCall = null;
    emit(call.id, 'system', { system: 'Phone', action: 'call ended', ok: true, summary: 'call ended' });
    const ws = socket;
    socket = null;
    ws?.close();   // closing the stream ends <Connect>, and with no TwiML after it Twilio hangs up
  }

  async function begin(call, sendAudio, onInterrupt) {
    const session = await startSession({ call, specs: tools.specs, runTool: tools.runTool, sendAudio, onInterrupt, emit });
    if (store.activeCall !== call) { session?.close(); return; }   // the caller hung up while the model was starting
    call.session = session;
    emit(call.id, 'system', { system: 'Phone', action: 'call started', ok: true, summary: 'call connected' });
  }

  /** POST /twilio/voice: accept one known caller at a time. */
  async function voice(req, res) {
    const params = await signedForm(req, res);
    if (!params) return;
    const twiml = new VoiceResponse();
    if (!store.members.some((m) => samePhone(m.phone, params.From))) {
      console.log('[twilio] call refused: number not registered');
      twiml.say('Sorry, this phone number is not registered with CATE. Goodbye.');
      twiml.hangup();
    } else if (store.activeCall) {
      console.log('[twilio] call refused: line busy');
      twiml.say('Sorry, CATE is on another call. Please try again in a few minutes. Goodbye.');
      twiml.hangup();
    } else {
      const call = newCall(params.From);
      const timer = setTimeout(() => endCall(call), STREAM_WAIT_MS);
      timer.unref();
      pending = { token: newToken(), call, timer };
      twiml.connect().stream({ url: `${config.baseUrl.replace(/^http/, 'ws')}/twilio/stream` })
        .parameter({ name: 'token', value: pending.token });
    }
    xml(res, twiml);
  }

  /** WS /twilio/stream: nothing happens until `start` carries the one-time token from the voice webhook. */
  function stream(ws) {
    let call = null;
    let streamSid = null;
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...msg, streamSid })); };
    const deadline = setTimeout(() => ws.close(), START_WAIT_MS);
    deadline.unref();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.event === 'start' && !call) {
        if (!pending || !safeEqual(msg.start?.customParameters?.token, pending.token)) return ws.close();
        clearTimeout(deadline);
        clearTimeout(pending.timer);
        call = pending.call;
        pending = null;   // one-time: the token is gone once used
        socket = ws;
        streamSid = msg.start.streamSid;
        begin(
          call,
          (pcm) => {
            const bytes = encode(pcm);
            for (let i = 0; i < bytes.length; i += FRAME) {
              send({ event: 'media', media: { payload: bytes.subarray(i, i + FRAME).toString('base64') } });
            }
          },
          () => send({ event: 'clear' }),
        ).catch((err) => {
          console.error(`[call ${call.id}] model session failed to start: ${err.message}`);
          endCall(call);
        });
      } else if (msg.event === 'media' && call) {
        call.session?.audioIn(decode(Buffer.from(msg.media.payload, 'base64')));
      } else if (msg.event === 'stop') {
        ws.close();
      }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => { clearTimeout(deadline); endCall(call); });
  }

  /** POST /twilio/sms: "PAY" from a delegate's number pays that member's held booking. Anything else is ignored. */
  async function sms(req, res) {
    const params = await signedForm(req, res);
    if (!params) return;
    if ((params.Body ?? '').trim().toUpperCase() === 'PAY') {
      // ponytail: PAY names no booking, so it pays the latest held one this number may pay for. Stripe checkout is per booking.
      const order = store.orders.findLast((o) => o.status === 'held'
        && findMember(o.member_id)?.delegates?.some((d) => samePhone(d.phone, params.From)));
      if (order) await payment.onPaid(order.ref, 'sms');
      else console.log('[twilio] PAY ignored: not from a delegate with a held booking');
    }
    xml(res, new MessagingResponse());
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

  return { voice, stream, sms, simulate, endCall };
}
