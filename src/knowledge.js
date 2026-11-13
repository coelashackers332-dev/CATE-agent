// General Cathay knowledge for the ask_cathay tool: load passages from knowledge/*.md and find the ones
// that answer a question. Returns [] when nothing is relevant enough, so the tool says "I do not have that".
//
// Passage file format (one file per topic, any number of passages per file):
//
//   ## Checked baggage
//   Source: https://www.cathaypacific.com/...
//   Checked: 2026-11-13
//   Asks: how many bags can I bring; luggage allowance; suitcase weight
//
//   The answer in plain spoken words, one short paragraph.
//
// `Source` and `Checked` are required: a passage without them is skipped, so nothing unsourced can be read out.
// `Asks` is optional: ways a caller might put the question. It is searched, never read out.
//
// ponytail: KNOWLEDGE=keyword matches words, so a question worded unlike the passage and its `Asks` line is missed.
// Fine for a few dozen curated passages; KNOWLEDGE=embeddings (Bedrock, not built yet) is the upgrade.
import { readdirSync, readFileSync, existsSync } from 'node:fs';

// A passage must contain at least half of the question's words, weighted by rarity. Lower lets one common word
// ("bring") answer a question about something we do not cover ("my dog"); higher drops loosely worded questions.
const MIN_SCORE = 0.5;
const STOP = new Set(('a an and any are about as at be can could do does for from get have how i if in is it like me much many my '
  + 'need of on or please s should tell that the there this to want what when where which who will with would you your').split(' '));

/** "Wheelchairs", "batteries" → "wheelchair", "battery": enough stemming for plurals. */
const stem = (w) => (w.length > 3 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** The distinct meaningful words of a text. */
const words = (text) => new Set(String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter((w) => w.length > 1 && !STOP.has(w)).map(stem));

/** Parse one knowledge file. Passages without a source and a checked date are skipped with a warning. */
export function parsePassages(markdown, file = 'knowledge') {
  const passages = [];
  for (const block of String(markdown).split(/^## +/m).slice(1)) {
    const [title, ...rest] = block.split(/\r?\n/);
    const meta = {};
    const body = [];
    for (const line of rest) {
      const m = line.match(/^(Source|Checked|Asks):\s*(.*)$/i);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      else body.push(line);
    }
    const text = body.join(' ').replace(/\s+/g, ' ').trim();
    if (!meta.source || !meta.checked || !text) {
      console.warn(`[knowledge] skipped "${title.trim()}" in ${file}: it needs Source, Checked and a text`);
      continue;
    }
    passages.push({ title: title.trim(), text, source: meta.source, checked: meta.checked, asks: meta.asks ?? '' });
  }
  return passages;
}

/** All passages from knowledge/*.md. A missing or empty folder gives []. */
export function loadPassages(dir = new URL('../knowledge/', import.meta.url)) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
    .flatMap((name) => parsePassages(readFileSync(new URL(name, dir), 'utf8'), name));
}

/**
 * @param {{ passages: object[], mode?: 'keyword' | 'embeddings' }} options
 * @returns {{ search(question: string, limit?: number): Promise<object[]> }}  best first; [] when nothing is relevant
 */
export function createKnowledge({ passages, mode = 'keyword' }) {
  if (mode !== 'keyword') throw new Error(`KNOWLEDGE=${mode} is not built yet; use KNOWLEDGE=keyword`);

  const indexed = passages.map((p) => ({ passage: p, has: words(`${p.title} ${p.asks} ${p.text}`) }));
  // Rare words count for more. A word no passage contains counts most of all, so a question that is mainly
  // about something we do not cover ("visa", "weather") scores low even if one common word matches.
  const count = new Map();
  for (const { has } of indexed) for (const w of has) count.set(w, (count.get(w) ?? 0) + 1);
  const weight = (w) => Math.log(1 + indexed.length / (count.get(w) ?? 0.5));

  async function search(question, limit = 3) {
    const asked = [...words(question)];
    const total = asked.reduce((sum, w) => sum + weight(w), 0);
    if (!total) return [];
    return indexed
      .map(({ passage, has }) => ({ passage, score: asked.reduce((sum, w) => sum + (has.has(w) ? weight(w) : 0), 0) / total }))
      .filter((hit) => hit.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ passage: { title, text, source, checked }, score }) => ({ title, text, source, checked, score: Math.round(score * 100) / 100 }));
  }

  return { search };
}
