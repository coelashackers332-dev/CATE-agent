import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/model/prompt.js';
import { createTools } from '../src/tools.js';
import { existsSync as demoFileExists } from 'node:fs';
const HAS_DEMO = demoFileExists(new URL('../src/model/prompt_demo.js', import.meta.url));   // demo mode is optional

// The full call unless a test asks for the demo one: a PROMPT=demo in .env must not change what these tests check.
delete process.env.PROMPT;

test('prompt carries the date, names every tool, and names nothing that is not a tool or a tool input', () => {
  const prompt = systemPrompt({ today: '2026-11-14' });
  assert.match(prompt, /Today is 2026-11-14\./);
  assert.match(systemPrompt(), /Today is \d{4}-\d{2}-\d{2}\./, 'the default date is YYYY-MM-DD');

  const { specs } = createTools({});
  const names = specs.map((s) => s.name);
  for (const name of names) assert.ok(prompt.includes(name), `prompt does not mention ${name}`);
  // Everything written like_this must exist in the tool specs, so a renamed or removed tool cannot stay in the prompt.
  const known = new Set([...names, ...specs.flatMap((s) => Object.keys(s.inputSchema.properties))]);
  for (const word of prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g)) assert.ok(known.has(word), `prompt names ${word}, which is not a tool or a tool input`);

  assert.doesNotMatch(prompt, /\+\d{6,}|@|WCH[CRS]/, 'no phone number, email address or wheelchair code in the prompt');
});

test('PROMPT=demo (optional): the short stage prompt names only real tools, tool inputs and result fields, and asks for nothing private', { skip: !HAS_DEMO && 'no src/model/prompt_demo.js' }, () => {
  const before = process.env.PROMPT;
  process.env.PROMPT = 'demo';
  try {
    const prompt = systemPrompt({ today: '2026-11-15' });
    assert.match(prompt, /about ninety seconds/);
    assert.match(prompt, /Today is 2026-11-15\./);
    const { specs } = createTools({});
    const known = new Set([...specs.map((s) => s.name), ...specs.flatMap((s) => Object.keys(s.inputSchema.properties)), 'read_out']);
    for (const word of prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g)) assert.ok(known.has(word), `demo prompt names ${word}, which is not a tool, an input or a result field`);
    assert.doesNotMatch(prompt, /\+\d{6,}|@|WCH[CRS]/);
  } finally {
    if (before === undefined) delete process.env.PROMPT; else process.env.PROMPT = before;
  }
  assert.doesNotMatch(systemPrompt({ today: '2026-11-15' }), /about ninety seconds/, 'without PROMPT=demo, the full prompt');
});
