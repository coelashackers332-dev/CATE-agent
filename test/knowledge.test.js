// The keyword search behind ask_cathay: finds the right passage, and returns nothing rather than a weak match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePassages, loadPassages, createKnowledge } from '../src/knowledge.js';

const FILE = `# Notes above the first passage are ignored

## Checked baggage
Source: https://example.com/baggage
Checked: 2026-11-13
Asks: how many bags can I bring; luggage allowance; suitcase weight

Economy tickets include one checked bag
of up to 23 kilograms.

## Wheelchair help at the airport
Source: https://example.com/assistance
Checked: 2026-11-13
Asks: who pushes my wheelchair; help getting to the gate

Staff meet you at check-in with a wheelchair and take you to the gate.

## Bringing your own wheelchair
Source: https://example.com/mobility-aids
Checked: 2026-11-13
Asks: can I take my own wheelchair on the plane; walking frame; battery

Your own wheelchair travels free of charge in the hold. Tell us its battery type.

## Arriving at the airport
Source: https://example.com/check-in
Checked: 2026-11-13
Asks: how early should I arrive; what time does check-in close

Please arrive three hours before departure if you have asked for assistance.

## No source, so never read out
Checked: 2026-11-13

Something nobody checked.
`;

test('parsePassages: title, source, date and text; unsourced passages are skipped', () => {
  const passages = parsePassages(FILE, 'test.md');
  assert.deepEqual(passages.map((p) => p.title), ['Checked baggage', 'Wheelchair help at the airport', 'Bringing your own wheelchair', 'Arriving at the airport']);
  assert.deepEqual(passages[0], {
    title: 'Checked baggage', text: 'Economy tickets include one checked bag of up to 23 kilograms.',
    source: 'https://example.com/baggage', checked: '2026-11-13', asks: 'how many bags can I bring; luggage allowance; suitcase weight',
  });
});

test('search: the right passage first, with its source, and never the Asks line', async () => {
  const { search } = createKnowledge({ passages: parsePassages(FILE) });
  const top = async (question) => (await search(question))[0]?.title;

  assert.equal(await top('How many bags can I bring?'), 'Checked baggage');
  assert.equal(await top('What is the luggage allowance?'), 'Checked baggage');
  assert.equal(await top('Can I take my own wheelchair on the plane?'), 'Bringing your own wheelchair');
  assert.equal(await top('Who will help me get to the gate?'), 'Wheelchair help at the airport');
  assert.equal(await top('How early should I arrive at the airport?'), 'Arriving at the airport');

  const [hit] = await search('How many bags can I bring?');
  assert.deepEqual(Object.keys(hit), ['title', 'text', 'source', 'checked', 'score']);
  assert.equal(hit.source, 'https://example.com/baggage');
  assert.ok(hit.score >= 0.5 && hit.score <= 1);
});

test('search: nothing relevant gives [], not the nearest guess', async () => {
  const { search } = createKnowledge({ passages: parsePassages(FILE) });
  assert.deepEqual(await search('Do I need a visa for Canada?'), []);
  assert.deepEqual(await search("What's the weather in Vancouver?"), []);
  assert.deepEqual(await search('Can I bring my dog?'), []);       // "bring" matches, "dog" is not covered
  assert.deepEqual(await search(''), []);
  assert.deepEqual(await search('how do I'), []);                   // only filler words
});

test('search: limit, empty knowledge base, unbuilt mode, missing folder', async () => {
  const passages = parsePassages(FILE);
  assert.equal((await createKnowledge({ passages }).search('wheelchair', 1)).length, 1);
  assert.equal((await createKnowledge({ passages }).search('wheelchair')).length, 2);
  assert.deepEqual(await createKnowledge({ passages: [] }).search('How many bags can I bring?'), []);
  assert.throws(() => createKnowledge({ passages, mode: 'embeddings' }), /not built yet/);
  assert.deepEqual(loadPassages(new URL('./no-such-folder/', import.meta.url)), []);
});

test('the shipped knowledge/ folder: every passage loads, with a source, a date and a unique title', async () => {
  const passages = loadPassages();
  assert.ok(passages.length >= 1);
  for (const p of passages) assert.ok(p.title && p.text && p.source && p.checked, p.title);
  assert.equal(new Set(passages.map((p) => p.title)).size, passages.length);
  // Every "## " heading in the folder became a passage: none was skipped for a missing Source or Checked line.
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../knowledge/', import.meta.url);
  const headings = readdirSync(dir).filter((f) => f.endsWith('.md'))
    .flatMap((f) => readFileSync(new URL(f, dir), 'utf8').match(/^## .+$/gm) ?? []);
  assert.equal(passages.length, headings.length);
});
