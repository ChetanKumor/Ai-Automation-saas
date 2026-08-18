'use strict';

// HERO-1 phase 5 — the hero's honesty label, pinned.
//
// WHY THIS FILE EXISTS AT ALL. Phase 5 replaced `HeroChat` with the
// conversation module. `HeroChat` rendered one visible disclosure — a caption
// saying the thread is an example — and that caption is not incidental copy:
// the site's whole position is that it does not fabricate, so a hero that
// gained a booking-confirmation animation while quietly dropping its own
// disclosure would be the one dishonest thing on a careful page.
//
// That is a failure mode nothing else catches. `next build` does not care. The
// pixel gates are gone by design on `/`. The live-DOM sweep that verified it
// this session ran once, in a session, and sessions end. A caption can be
// deleted in a one-line diff and every remaining gate stays green.
//
// WHAT THIS CAN AND CANNOT SEE, stated plainly because a test that oversells
// itself is worse than none. It reads SOURCE. It cannot prove the sentence
// reaches the DOM, is visible, is legible, or is not `display: none` — that was
// measured off a running page at 360/768/1440 in all six playback states and
// is recorded in docs/os/state.md. What it CAN do is fail the moment the
// sentence stops being in the component, which is the way it would actually be
// lost.
//
// NOT VACUOUS, and checked rather than asserted. Two source pins in this repo
// have gone quietly vacuous before, both by matching something that would have
// matched anyway. So every needle below is required to be ABSENT from a control
// string as well as present in the file — see the `mustNotMatch` rail — and the
// disclosure is matched as a whole sentence rather than as a keyword that any
// marketing paragraph could satisfy.
//
// ONE test() block, for the reason conversationProvenance.test.js gives in its
// own header: the suite total is a tracked number and a per-assertion block
// would move it every time an assertion is added.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const SECTIONS = path.join(ROOT, 'web', 'components', 'sections');
const HERO = path.join(SECTIONS, 'Hero.tsx');
const HERO_CSS = path.join(SECTIONS, 'Hero.module.css');

/** JSX wraps prose across lines and indents it. The rendered text is the source
 *  with runs of whitespace collapsed, which is exactly what React does with the
 *  children of an element, so comparing against a collapsed source is comparing
 *  against what ships — not a loose "contains these words somewhere". */
const collapse = (s) => s.replace(/\s+/g, ' ');

// The disclosure, as it must read. Migrated from HeroChat.tsx by DELETION only
// at phase 5: ", here in Telugu — the replies are translated beneath" went,
// because the reader now chooses the language and there is no gloss line. No
// word here was authored. Changing it is a copy decision and belongs in a copy
// session, which is what this assertion makes someone notice.
const DISCLOSURE =
  'An example of Prantivo booking a patient appointment on WhatsApp. It ' +
  'also answers in Hindi and English, and a staff member can take over the ' +
  'chat at any point.';

test('the hero renders its honesty disclosure, and HeroChat is gone', () => {
  const hero = fs.readFileSync(HERO, 'utf8');
  const heroFlat = collapse(hero);

  // ── The disclosure itself ────────────────────────────────────────────────
  assert.ok(
    heroFlat.includes(DISCLOSURE),
    'Hero.tsx no longer renders the honesty disclosure.\n' +
      'Expected this sentence, whitespace-collapsed:\n  ' + DISCLOSURE + '\n' +
      'The hero shows a booked appointment. It must say it is an example.'
  );

  // It has to be RENDERED, not sitting in a comment explaining why it is gone.
  // Comments are stripped and the sentence must survive that.
  const withoutComments = collapse(
    hero.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ')
  );
  assert.ok(
    withoutComments.includes(DISCLOSURE),
    'The disclosure appears in Hero.tsx only inside a comment. A comment is ' +
      'not a disclosure — it has to be in the rendered tree.'
  );

  // It opens by disclaiming. "An example" is the load-bearing half; a sentence
  // that kept the product claims and dropped the framing would still contain
  // most of these words.
  assert.ok(
    DISCLOSURE.startsWith('An example'),
    'The disclosure must lead with the disclaimer, not bury it.'
  );

  // The class it is rendered with must exist in the stylesheet. A caption
  // styled by a class nobody defines still renders, but at the browser's
  // default size and colour rather than as microcopy — silently.
  const cls = withoutComments.match(/className=\{styles\.(chatCaption|waCaption)\}/);
  assert.ok(cls, 'The disclosure is not rendered through a styles.* class.');
  const css = fs.readFileSync(HERO_CSS, 'utf8');
  assert.ok(
    new RegExp('^\\.' + cls[1] + '\\s*\\{', 'm').test(css),
    `Hero.tsx renders the caption with styles.${cls[1]}, but Hero.module.css ` +
      `does not define .${cls[1]}.`
  );

  // ── HeroChat is retired, and cannot come back by accident ────────────────
  assert.ok(
    !fs.existsSync(path.join(SECTIONS, 'HeroChat.tsx')),
    'HeroChat.tsx is back. Its provenance comment lives in ' +
      'web/components/sections/conversation/index.ts now; two copies of the ' +
      'same record drift.'
  );
  // Comment-stripped, deliberately. Hero.tsx's own header explains what was
  // there before and why it went, and that history is worth keeping — what
  // must not come back is an import or an element.
  assert.ok(
    !/HeroChat/.test(withoutComments),
    'Hero.tsx still imports or renders HeroChat.'
  );

  // ── The hero mounts the conversation module ──────────────────────────────
  assert.ok(
    /LanguageSwitchedConversation/.test(withoutComments),
    'Hero.tsx no longer mounts the conversation. If the hero has stopped ' +
      'showing a conversation at all, this file is the wrong gate — but it ' +
      'should fail loudly rather than pass quietly.'
  );

  // ── THE NON-VACUITY RAIL ─────────────────────────────────────────────────
  // Every needle above is required to be absent from a control that resembles
  // the page's other copy. If any of them matched this, the assertion that
  // matched Hero.tsx proved nothing about the disclosure.
  const CONTROL =
    'Patients message your clinic at 11 PM, during a procedure, on a Sunday. ' +
    'Prantivo answers in seconds — in Telugu, Hindi or English — quotes your ' +
    'prices, and books the appointment. On your clinic’s own WhatsApp number. ' +
    'Message it in Telugu. It answers in Telugu. Booked before they message ' +
    'another clinic. An example of something else entirely.';
  for (const needle of [DISCLOSURE, 'LanguageSwitchedConversation']) {
    assert.ok(
      !CONTROL.includes(needle),
      `NON-VACUOUS CHECK FAILED: ${JSON.stringify(needle.slice(0, 40))} matches ` +
        'ordinary hero copy, so finding it in Hero.tsx establishes nothing.'
    );
  }
  // …and the file this all reads must actually be the hero, not an empty read.
  assert.ok(
    hero.length > 2000 && /export function Hero\(/.test(hero),
    'Hero.tsx did not look like the hero component — the assertions above ' +
      'were reading the wrong file or an empty one.'
  );
});
