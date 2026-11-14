// MODEL=nova: the voice model. Amazon Nova 2 Sonic over Bedrock's bidirectional stream, one stream per call.
// Same startSession interface as model/scripted.js (CONTRACTS.md §5). Phone audio is 8 kHz 16-bit mono PCM both
// ways and Nova takes and gives 8 kHz directly, so nothing here resamples.
// Event shapes: Amazon Nova 2 user guide, "Handling input events" / "Handling output events with the bidirectional API".
// ponytail: no session rotation. Nova ends a connection after 8 minutes; the demo call is well under that.
import '../config.js';   // loads .env, so AWS_PROFILE, AWS_REGION and NOVA_* below apply
import { randomUUID } from 'node:crypto';
import { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { systemPrompt, CALL_CONNECTED } from './prompt.js';

const AUDIO = { mediaType: 'audio/lpcm', sampleRateHertz: 8000, sampleSizeBits: 16, channelCount: 1, encoding: 'base64' };

const settings = () => ({
  region: process.env.AWS_REGION || 'ap-northeast-1',            // Nova 2 Sonic is in-region only: Tokyo works from HK
  modelId: process.env.NOVA_MODEL_ID || 'amazon.nova-2-sonic-v1:0',
  voiceId: process.env.NOVA_VOICE || 'tiffany',
  endpointing: process.env.NOVA_ENDPOINTING || 'MEDIUM',         // HIGH | MEDIUM | LOW: how soon a pause ends the caller's turn
});

let shared = null;
function bedrock(region) {
  if (shared?.region !== region) {
    // The bidirectional stream needs HTTP/2. Reused across calls so each call skips the TLS handshake.
    const requestHandler = new NodeHttp2Handler({ requestTimeout: 300_000, sessionTimeout: 300_000, disableConcurrentStreams: false, maxConcurrentStreams: 20 });
    shared = { region, client: new BedrockRuntimeClient({ region, requestHandler }) };
  }
  return shared.client;
}

/** tools.specs (JSON Schema objects) → Nova's toolConfiguration (schemas as JSON strings). */
export const toolConfiguration = (specs) => ({
  tools: specs.map(({ name, description, inputSchema }) => ({ toolSpec: { name, description, inputSchema: { json: JSON.stringify(inputSchema) } } })),
});

/** Int16Array → base64 of little-endian 16-bit samples (what audio/lpcm means). */
export function pcmToBase64(pcm) {
  const bytes = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2);
  return bytes.toString('base64');
}

/** base64 little-endian 16-bit samples → Int16Array. */
export function base64ToPcm(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const pcm = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return pcm;
}

/** The first Nova Sonic marked a barge-in with this text; Nova 2 uses stopReason INTERRUPTED. Both are handled. */
export function isInterruptSignal(text) {
  if (!text?.trimStart().startsWith('{')) return false;
  try { return JSON.parse(text).interrupted === true; } catch { return false; }
}

function stageOf(additionalModelFields) {
  try { return JSON.parse(additionalModelFields).generationStage ?? 'FINAL'; } catch { return 'FINAL'; }
}

/** The request body: an async iterable the SDK pulls events from, fed by push() until end(). */
function eventQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  const poke = () => { wake?.(); wake = null; };
  return {
    push(item) { if (!ended) { items.push(item); poke(); } },
    end() { ended = true; poke(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) yield items.shift();
        else if (ended) return;
        else await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

/**
 * CONTRACTS.md §5. Resolves once Bedrock has accepted the stream; rejects if it can't (no credentials, no model
 * access), which phone.js turns into a log line and a hang-up. `client` is for tests.
 */
export async function startSession({ call, specs, runTool, sendAudio, onInterrupt, emit, client }) {
  const s = settings();
  const promptName = randomUUID();
  const audioName = randomUUID();
  const queue = eventQueue();
  const send = (event) => queue.push({ chunk: { bytes: Buffer.from(JSON.stringify({ event })) } });
  let closed = false;

  function sendText(role, content, interactive) {
    const contentName = randomUUID();
    send({ contentStart: { promptName, contentName, type: 'TEXT', interactive, role, textInputConfiguration: { mediaType: 'text/plain' } } });
    send({ textInput: { promptName, contentName, content } });
    send({ contentEnd: { promptName, contentName } });
  }

  // Opening, in the order Nova requires: session, prompt (voice, tools), system prompt, then the caller's audio,
  // which stays one open content block for the whole call, then the "call connected" line.
  send({ sessionStart: {
    inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
    turnDetectionConfiguration: { endpointingSensitivity: s.endpointing },
  } });
  send({ promptStart: {
    promptName,
    textOutputConfiguration: { mediaType: 'text/plain' },
    audioOutputConfiguration: { ...AUDIO, voiceId: s.voiceId, audioType: 'SPEECH' },
    toolUseOutputConfiguration: { mediaType: 'application/json' },
    toolConfiguration: toolConfiguration(specs),
  } });
  sendText('SYSTEM', systemPrompt(), false);
  send({ contentStart: { promptName, contentName: audioName, type: 'AUDIO', interactive: true, role: 'USER', audioInputConfiguration: { ...AUDIO, audioType: 'SPEECH' } } });
  // The prompt's step 1 starts on this line, so CATE greets the caller without waiting for a hello (model/prompt.js).
  sendText('USER', CALL_CONNECTED, true);

  let response;
  try {
    response = await (client ?? bedrock(s.region)).send(new InvokeModelWithBidirectionalStreamCommand({ modelId: s.modelId, body: queue }));
  } catch (err) {
    queue.end();
    throw err;
  }

  /** Run the tool Nova asked for and give it the result. runTool never throws by contract; this guards it anyway. */
  async function answerTool({ toolUseId, toolName, content }) {
    let args = {};
    try { args = content ? JSON.parse(content) : {}; } catch { /* unreadable args: run with none and let the tool say what's missing */ }
    let result;
    try { result = await runTool(toolName, args, call); } catch { result = { ok: false, error: 'That did not work on our side. Say sorry, and try once more.' }; }
    if (closed) return;
    const contentName = randomUUID();
    send({ contentStart: { promptName, contentName, interactive: false, type: 'TOOL', role: 'TOOL',
      toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } });
    send({ toolResult: { promptName, contentName, content: JSON.stringify(result ?? {}) } });
    send({ contentEnd: { promptName, contentName } });
  }

  const blocks = new Map();   // contentId → { role, stage } of the open output block
  let toolRequest = null;

  function handle(ev) {
    if (ev.contentStart) {
      const { contentId, role, additionalModelFields } = ev.contentStart;
      blocks.set(contentId, { role, stage: stageOf(additionalModelFields) });
    } else if (ev.textOutput) {
      const { contentId, content } = ev.textOutput;
      if (isInterruptSignal(content)) return onInterrupt();
      const block = blocks.get(contentId);
      // FINAL only: SPECULATIVE is the plan before speaking, FINAL is what was really said (cut short on a barge-in).
      if (block?.stage !== 'FINAL' || !content) return;
      if (block.role === 'USER') emit(call.id, 'caller_said', { text: content });
      else if (block.role === 'ASSISTANT') emit(call.id, 'cate_said', { text: content });
    } else if (ev.audioOutput) {
      if (!closed) sendAudio(base64ToPcm(ev.audioOutput.content));
    } else if (ev.toolUse) {
      toolRequest = ev.toolUse;
    } else if (ev.contentEnd) {
      const { contentId, type, stopReason } = ev.contentEnd;
      blocks.delete(contentId);
      if (stopReason === 'INTERRUPTED') onInterrupt();
      if (type === 'TOOL' && toolRequest) {
        const request = toolRequest;
        toolRequest = null;
        answerTool(request);   // not awaited: Nova's output keeps flowing while a slow tool runs
      }
    }
  }

  (async () => {
    for await (const part of response.body) {
      if (!part.chunk?.bytes) {
        const [kind, detail] = Object.entries(part)[0] ?? ['unknown', {}];
        throw new Error(`${kind}: ${detail?.message ?? 'stream error'}`);
      }
      handle(JSON.parse(Buffer.from(part.chunk.bytes).toString('utf8')).event ?? {});
    }
  })().catch((err) => {
    queue.end();
    if (closed) return;
    console.error(`[nova ${call.id}] ${err.message}`);
    emit(call.id, 'system', { system: 'Phone', action: 'voice model stopped', ok: false, summary: '✗ voice model stopped' });
  });

  return {
    audioIn(pcm) {
      if (!closed) send({ audioInput: { promptName, contentName: audioName, content: pcmToBase64(pcm) } });
    },
    notify(text) {
      if (!closed) sendText('USER', text, true);   // cross-modal text: Nova hears it as part of the live conversation
    },
    close() {
      if (closed) return;
      closed = true;
      send({ contentEnd: { promptName, contentName: audioName } });
      send({ promptEnd: { promptName } });
      send({ sessionEnd: {} });
      queue.end();
    },
  };
}
