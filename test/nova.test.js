import test from 'node:test';
import assert from 'node:assert/strict';
import { startSession, toolConfiguration, pcmToBase64, base64ToPcm, isInterruptSignal } from '../src/model/nova.js';
import { CALL_CONNECTED } from '../src/model/prompt.js';
import { createTools } from '../src/tools.js';

const { specs } = createTools({});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, what) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  assert.fail(`timed out waiting for ${what}`);
}

/** A Bedrock client stand-in: records what CATE sends and plays back the given output parts. */
function fakeBedrock(parts = []) {
  const seen = { modelId: null, inputs: [], bodyEnded: false };
  return {
    seen,
    async send(command) {
      seen.modelId = command.input.modelId;
      (async () => {
        for await (const part of command.input.body) seen.inputs.push(JSON.parse(Buffer.from(part.chunk.bytes)).event);
        seen.bodyEnded = true;
      })();
      return { body: (async function* () { for (const part of parts) { await tick(); yield part; } })() };
    },
  };
}
const out = (event) => ({ chunk: { bytes: Buffer.from(JSON.stringify({ event })) } });
const names = (inputs) => inputs.map((e) => Object.keys(e)[0]);

function harness(parts, runTool = async () => ({ ok: true })) {
  const client = fakeBedrock(parts);
  const rec = { events: [], audio: [], interrupts: 0, tools: [] };
  const call = { id: 'c9' };
  const args = {
    call, specs, client,
    runTool: async (name, input, c) => { rec.tools.push({ name, input, c }); return runTool(name, input, c); },
    sendAudio: (pcm) => rec.audio.push(pcm),
    onInterrupt: () => { rec.interrupts += 1; },
    emit: (callId, kind, fields) => rec.events.push({ callId, kind, ...fields }),
  };
  return { client, rec, call, start: () => startSession(args) };
}

test('toolConfiguration: every tool, schema as a JSON string', () => {
  const { tools } = toolConfiguration(specs);
  assert.equal(tools.length, specs.length);
  for (const [i, { toolSpec }] of tools.entries()) {
    assert.equal(toolSpec.name, specs[i].name);
    assert.equal(toolSpec.description, specs[i].description);
    assert.deepEqual(JSON.parse(toolSpec.inputSchema.json), specs[i].inputSchema);
  }
});

test('pcm ↔ base64: little-endian 16-bit, extremes survive', () => {
  const pcm = Int16Array.of(0, 1, -1, 32767, -32768, 1234);
  assert.equal(Buffer.from(pcmToBase64(Int16Array.of(1))).toString(), Buffer.from([1, 0]).toString('base64'));
  assert.deepEqual([...base64ToPcm(pcmToBase64(pcm))], [...pcm]);
});

test('isInterruptSignal: only the interrupted marker', () => {
  assert.equal(isInterruptSignal('{ "interrupted" : true }'), true);
  assert.equal(isInterruptSignal('Hello, this is CATE.'), false);
  assert.equal(isInterruptSignal('{ not json'), false);
  assert.equal(isInterruptSignal(undefined), false);
});

test('opening events in Nova order; audio in at 8 kHz; close sends the closing events once', async () => {
  const { client, start } = harness([]);
  const session = await start();
  await until(() => client.seen.inputs.length >= 9, 'opening events');
  const [sessionStart, promptStart, sysStart, sysText, sysEnd, audioStart, hiStart, hiText, hiEnd] = client.seen.inputs;

  assert.equal(client.seen.modelId, 'amazon.nova-2-sonic-v1:0');
  assert.ok(sessionStart.sessionStart.turnDetectionConfiguration.endpointingSensitivity);
  assert.equal(promptStart.promptStart.audioOutputConfiguration.sampleRateHertz, 8000);
  assert.equal(promptStart.promptStart.toolConfiguration.tools.length, specs.length);
  assert.equal(sysStart.contentStart.role, 'SYSTEM');
  assert.match(sysText.textInput.content, /^You are CATE/, 'the system prompt is the text from model/prompt.js');
  assert.equal(sysEnd.contentEnd.contentName, sysStart.contentStart.contentName);
  assert.equal(audioStart.contentStart.type, 'AUDIO');
  assert.equal(audioStart.contentStart.audioInputConfiguration.sampleRateHertz, 8000);
  // The "call connected" line, sent once, so CATE speaks first.
  assert.equal(hiStart.contentStart.role, 'USER');
  assert.equal(hiText.textInput.content, CALL_CONNECTED);
  assert.equal(hiEnd.contentEnd.contentName, hiStart.contentStart.contentName);

  const promptName = promptStart.promptStart.promptName;
  assert.ok(client.seen.inputs.every((e) => !Object.values(e)[0].promptName || Object.values(e)[0].promptName === promptName));

  session.audioIn(Int16Array.of(5, -5));
  session.close();
  session.close();
  session.audioIn(Int16Array.of(1));   // after close: dropped
  await until(() => client.seen.bodyEnded, 'request body to end');

  const rest = client.seen.inputs.slice(9);
  assert.deepEqual(names(rest), ['audioInput', 'contentEnd', 'promptEnd', 'sessionEnd']);
  assert.deepEqual([...base64ToPcm(rest[0].audioInput.content)], [5, -5]);
  assert.equal(rest[0].audioInput.contentName, audioStart.contentStart.contentName);
  assert.equal(rest[1].contentEnd.contentName, audioStart.contentStart.contentName);
});

test('output: FINAL transcripts become events, audio goes to the phone, barge-in clears', async () => {
  const text = (contentId, role, stage) => out({ contentStart: { contentId, type: 'TEXT', role, additionalModelFields: JSON.stringify({ generationStage: stage }) } });
  const { rec, start } = harness([
    text('u1', 'USER', 'FINAL'), out({ textOutput: { contentId: 'u1', content: 'I want to go to Vancouver.' } }), out({ contentEnd: { contentId: 'u1', type: 'TEXT', stopReason: 'END_TURN' } }),
    text('a1', 'ASSISTANT', 'SPECULATIVE'), out({ textOutput: { contentId: 'a1', content: 'Planned words.' } }),
    out({ contentStart: { contentId: 'au1', type: 'AUDIO', role: 'ASSISTANT' } }),
    out({ audioOutput: { contentId: 'au1', content: pcmToBase64(Int16Array.of(7, 8, 9)) } }),
    out({ contentEnd: { contentId: 'au1', type: 'AUDIO', stopReason: 'PARTIAL_TURN' } }),
    text('a2', 'ASSISTANT', 'FINAL'), out({ textOutput: { contentId: 'a2', content: 'Here are three flights.' } }),
    out({ contentEnd: { contentId: 'a2', type: 'TEXT', stopReason: 'INTERRUPTED' } }),
    text('a3', 'ASSISTANT', 'FINAL'), out({ textOutput: { contentId: 'a3', content: '{ "interrupted" : true }' } }),
  ]);
  const session = await start();
  await until(() => rec.interrupts === 2, 'both barge-in signals');
  session.close();

  assert.deepEqual(rec.events.map(({ kind, text: t }) => [kind, t]), [
    ['caller_said', 'I want to go to Vancouver.'],
    ['cate_said', 'Here are three flights.'],
  ]);
  assert.ok(rec.events.every((e) => e.callId === 'c9'));
  assert.equal(rec.audio.length, 1);
  assert.ok(rec.audio[0] instanceof Int16Array);
  assert.deepEqual([...rec.audio[0]], [7, 8, 9]);
});

test('tool use: Nova asks, runTool runs with the call, the result goes back under the same toolUseId', async () => {
  const { client, rec, call, start } = harness([
    out({ contentStart: { contentId: 't1', type: 'TOOL', role: 'TOOL' } }),
    out({ toolUse: { contentId: 't1', toolName: 'find_flights', toolUseId: 'use-42', content: JSON.stringify({ to: 'Vancouver' }) } }),
    out({ contentEnd: { contentId: 't1', type: 'TOOL', stopReason: 'TOOL_USE' } }),
  ], async () => ({ ok: true, options: [{ id: '1' }] }));
  const session = await start();
  await until(() => names(client.seen.inputs).includes('toolResult'), 'tool result');
  session.close();

  assert.equal(rec.tools.length, 1);
  assert.equal(rec.tools[0].name, 'find_flights');
  assert.deepEqual(rec.tools[0].input, { to: 'Vancouver' });
  assert.equal(rec.tools[0].c, call);

  const i = names(client.seen.inputs).indexOf('toolResult');
  const [start_, result, end] = client.seen.inputs.slice(i - 1, i + 2);
  assert.equal(start_.contentStart.role, 'TOOL');
  assert.equal(start_.contentStart.toolResultInputConfiguration.toolUseId, 'use-42');
  assert.deepEqual(JSON.parse(result.toolResult.content), { ok: true, options: [{ id: '1' }] });
  assert.equal(end.contentEnd.contentName, start_.contentStart.contentName);
});

test('a stream error is one projector line, never a throw; a failed start rejects', async () => {
  const { rec, start } = harness([{ validationException: { message: 'bad event' } }]);
  await start();
  await until(() => rec.events.length === 1, 'error event');
  assert.equal(rec.events[0].kind, 'system');
  assert.equal(rec.events[0].ok, false);

  const failing = { async send() { throw new Error('no model access'); } };
  await assert.rejects(startSession({ call: { id: 'c1' }, specs, client: failing, runTool() {}, sendAudio() {}, onInterrupt() {}, emit() {} }), /no model access/);
});
