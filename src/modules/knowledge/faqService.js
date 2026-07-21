'use strict';

// FAQ service (PORTAL-P4-S11) — the Q/A editor over knowledge_chunks.
//
// FAQs are chunks tagged `source = 'faq'` (or `'faq:<lang>'` when the owner
// picks a language tag — see sourceFor/languageOf below). There is no separate
// `question`/`answer`/`language` column on knowledge_chunks (it was designed
// generic: one TEXT `content` blob + one TEXT `source` label), so both live in
// those two columns rather than as a schema change:
//
//   content — "Q: <question>\nA: <answer>", literally what gets embedded AND
//   what a retrieved chunk shows the model: aiService renders every chunk as
//   `- ${content}` straight into the prompt (see buildSystemPrompt), so the
//   stored text has to already read as a usable answer, not a record format
//   the model would have to decode.
//
//   source — 'faq' discriminates this row from a future 'document' chunk
//   (S12); 'faq:<lang>' additionally carries the owner's optional language
//   tag. Nothing else reads `source` as anything but a free label today
//   (validationService's kb checks count/retrieve across all sources), so
//   giving it this light structure is safe.
//
// Both question and answer are collapsed to a single line before storage —
// the same rule the booking-policy texts and safety guidance already use
// (routes.js normalizePolicy): it keeps the '\n' between "Q:" and "A:" the
// ONLY newline in `content`, so decoding a stored chunk back into
// { question, answer } for the edit form never has to guess where one ends
// and the other begins.
//
// There is no Zod schema behind this storage the way configService backs the
// config pages (same situation doctorService is in for tenant_entities), so
// this module is the structural validation gate, same role doctorService's
// `normalize()` plays — the portal route validates first with owner-friendly
// copy, and this is the gate that holds regardless of caller.

const knowledgeService = require('./knowledgeService');

const SOURCE_PREFIX = 'faq';
const MAX_FAQS = 100;       // spec §5.7 cap
const MAX_QUESTION = 200;
const MAX_ANSWER = 800;

class FaqValidationError extends Error {
  constructor(issues) {
    super('faq payload failed validation');
    this.name = 'FaqValidationError';
    this.issues = issues;
  }
}

function sourceFor(language) {
  return language ? `${SOURCE_PREFIX}:${language}` : SOURCE_PREFIX;
}
function isFaqSource(source) {
  return source === SOURCE_PREFIX || (typeof source === 'string' && source.startsWith(`${SOURCE_PREFIX}:`));
}
function languageOf(source) {
  const m = typeof source === 'string' ? /^faq:(.+)$/.exec(source) : null;
  return m ? m[1] : null;
}

function encode(question, answer) {
  return `Q: ${question}\nA: ${answer}`;
}
// The ONLY '\n' in a chunk we wrote is the one encode() inserts (both halves
// are pre-collapsed to one line by normalize()), so splitting on the first
// newline is exact, not a heuristic.
function decode(content) {
  const s = typeof content === 'string' ? content : '';
  const i = s.indexOf('\n');
  if (i === -1) return { question: '', answer: s.replace(/^A:\s*/, '') };
  return {
    question: s.slice(0, i).replace(/^Q:\s*/, ''),
    answer: s.slice(i + 1).replace(/^A:\s*/, ''),
  };
}

function project(row) {
  const { question, answer } = decode(row.content);
  return { id: row.id, question, answer, language: languageOf(row.source), created_at: row.created_at };
}

// Structural gate (mirrors doctorService.normalize): trims, collapses
// whitespace, enforces the length caps and that a language tag — if any — is
// one the tenant actually has enabled. Throws FaqValidationError; never
// returns a partially-invalid result.
function normalize({ question, answer, language }, allowedLanguages) {
  const issues = [];
  const q = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
  const a = typeof answer === 'string' ? answer.replace(/\s+/g, ' ').trim() : '';

  if (!q) issues.push({ path: 'question', message: 'question is required' });
  else if (q.length > MAX_QUESTION) issues.push({ path: 'question', message: `question must be ≤ ${MAX_QUESTION} characters` });

  if (!a) issues.push({ path: 'answer', message: 'answer is required' });
  else if (a.length > MAX_ANSWER) issues.push({ path: 'answer', message: `answer must be ≤ ${MAX_ANSWER} characters` });

  let lang = null;
  if (language !== undefined && language !== null && language !== '') {
    const allowed = Array.isArray(allowedLanguages) ? allowedLanguages : [];
    if (!allowed.includes(language)) issues.push({ path: 'language', message: `unknown language: ${String(language)}` });
    else lang = language;
  }

  if (issues.length) throw new FaqValidationError(issues);
  return { question: q, answer: a, language: lang };
}

async function listFaqs(tenantId) {
  const rows = await knowledgeService.listChunks(tenantId);
  return rows.filter((r) => isFaqSource(r.source)).map(project);
}

async function countFaqs(tenantId) {
  return knowledgeService.countChunksBySourcePrefix(tenantId, SOURCE_PREFIX);
}

async function createFaq(tenantId, input, opts = {}) {
  const { question, answer, language } = normalize(input, opts.languages);
  if (await countFaqs(tenantId) >= MAX_FAQS) {
    throw new FaqValidationError([{ path: 'question', message: `at most ${MAX_FAQS} FAQs` }]);
  }
  const row = await knowledgeService.createChunk(tenantId, {
    content: encode(question, answer),
    source: sourceFor(language),
  });
  return project(row);
}

// Returns null when the id isn't this tenant's (INV-1 — same contract as
// knowledgeService.getChunk/updateChunk).
async function updateFaq(tenantId, id, input, opts = {}) {
  const { question, answer, language } = normalize(input, opts.languages);
  const row = await knowledgeService.updateChunk(tenantId, id, {
    content: encode(question, answer),
    source: sourceFor(language),
  });
  return row ? project(row) : null;
}

async function deleteFaq(tenantId, id) {
  return knowledgeService.deleteChunk(tenantId, id);
}

module.exports = {
  listFaqs, countFaqs, createFaq, updateFaq, deleteFaq,
  FaqValidationError, MAX_FAQS, MAX_QUESTION, MAX_ANSWER,
};
