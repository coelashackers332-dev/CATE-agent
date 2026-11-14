import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt } from '../src/model/prompt.js';
import { createTools } from '../src/tools.js';

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
