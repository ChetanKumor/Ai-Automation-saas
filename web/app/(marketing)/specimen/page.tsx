import type { Metadata } from "next";
import styles from "./specimen.module.css";
import { TOKENS, GROUNDS, PALETTE, byGroup, verdict, type Verdict } from "./tokens";
import { Conversation, to12Hour } from "@/components/sections/conversation/Conversation";
import { LanguageSwitchedConversation } from "@/components/sections/conversation/LanguageSelector";
import {
  getConversation,
  LANGUAGES,
  type LangCode,
  type Turn,
} from "@/components/sections/conversation";
import fixture from "../../../../public/demo/fixture.json";

/* ============================================================================
 * Phase 1b token specimen. Server component — no "use client", no hooks, no
 * client island. Everything below is static markup plus CSS.
 *
 * It lives inside the (marketing) route group DELIBERATELY. Nav and Footer
 * render above and below from the old dark tokens, so the two systems sit on
 * one page and dormancy is something you can see rather than something the
 * commit message asserts.
 *
 * HERO-1 phase 2 appends a second specimen below the first: the Conversation
 * component, four instances, static. Same reason the token table is here — a
 * component whose central primitive nobody has looked at is not reviewable, and
 * the recency ladder in particular is a thing you either see working or do not.
 *
 * NOT linked from Nav or Footer. Reached by typing the URL.
 * ========================================================================== */

// Load-bearing. web/app/layout.tsx sets `robots: { index: true, follow: true }`
// at the root, so a child that says nothing INHERITS index:true — and
// web/app/robots.ts allows "/", so robots.txt blocks nothing either. This
// page-level metadata is the only thing keeping an internal design document
// out of the index.
export const metadata: Metadata = {
  title: "Token specimen",
  description: "Internal design specimen for the Warm Paper token layer.",
  robots: { index: false, follow: false },
};

const VERDICT_CLASS: Record<Verdict, string> = {
  TEXT: styles.vText,
  "LARGE-ONLY": styles.vLarge,
  "NON-TEXT ONLY": styles.vNone,
};

function Cell({ ratio }: { ratio: number }) {
  const v = verdict(ratio);
  return (
    <td>
      <span className={styles.ratio}>{ratio.toFixed(2)}:1</span>
      <span className={`${styles.verdict} ${VERDICT_CLASS[v]}`}>{v}</span>
    </td>
  );
}

const TYPE_STEPS = [
  {
    token: "--type-display",
    cls: styles.sDisplay,
    track: "--track-display",
    latin: "Warm Paper",
    te: "రేపు కలుద్దాం",
  },
  {
    token: "--type-lede",
    cls: styles.sLede,
    track: "--track-lede",
    latin: "A ground that reads like paper, not like a screen turned down.",
    te: "నమస్తే! రేపు, అంటే శనివారం",
  },
  {
    token: "--type-body",
    cls: styles.sBody,
    track: "none",
    latin:
      "Body copy sits at a measure of 66 characters, which is a count and not a pixel width — the line holds its shape when the reader changes their text size.",
    te: "డాక్టర్ ఎప్పుడు అవైలబుల్ గా ఉన్నారు",
  },
  {
    token: "--type-meta",
    cls: styles.sMeta,
    track: "none",
    latin: "Last updated · 15 August 2026",
    te: "అంతే, ధన్యవాదాలు",
  },
];

// Phase 1's data, consumed unedited. `te` because the hero's own subhead claims
// Telugu and this is the claim the product can prove for free.
const CONVERSATION = getConversation("te");

/* Every language LANGUAGES offers, resolved here on the server. Building the
 * map from the same list the selector renders its segments from is what makes
 * "no option throws" structural rather than remembered: a language cannot
 * become a segment without appearing here, and it cannot appear here without
 * strings, because getConversation would have thrown on the way. */
const CONVERSATIONS = Object.fromEntries(
  LANGUAGES.map((code) => [code, getConversation(code)])
) as Partial<Record<LangCode, Turn[]>>;

/* ── THE SERVER→CLIENT BOUNDARY ───────────────────────────────────────────────
 *
 * This narrowing is the whole reason it lives here rather than inside the
 * component. Phase 2's Conversation was a server component and read
 * fixture.json itself; phase 3 gives it a client wrapper, which drags every
 * module it imports into a browser chunk. So the fixture is read HERE — in a
 * server component, which this page still is — and exactly three strings are
 * handed across.
 *
 * What stays behind, and is verified to stay behind by grepping .next/static/:
 *   appointment.id            8667b5bc-6509-46df-bf30-051478bd4a95
 *   customer.name             a synthetic patient
 *   tenant                    "Smile Dental (Voice Dev)", a dev tenant
 *   appointment.date          2026-07-18, four weeks stale
 *
 * The formatting rule is imported rather than copied: one definition of what
 * "09:00" renders as, in the component that renders it.
 * ────────────────────────────────────────────────────────────────────────── */
const RECORD = {
  status: fixture.appointment.status,
  time: to12Hour(fixture.appointment.time),
  doctor: fixture.appointment.doctor_name,
} as const;

// Four states of one scalar. `CONVERSATION.length` — not a literal 6 — is the
// "complete" value: activeIndex one past the last turn is what puts the
// confirmation record on screen, and hardcoding 6 would quietly render a
// six-turn thread with no card the day a seventh turn is authored.
const INSTANCES = [
  { activeIndex: 0, note: "idle — only t0 has arrived, resting at the bottom of a full-height region" },
  { activeIndex: 2, note: "mid-thread — t2 active, t1 one step back, t0 on the floor" },
  { activeIndex: 5, note: "the last turn active; the record has not landed yet" },
  { activeIndex: CONVERSATION.length, note: "complete — every turn, plus the confirmation record" },
];

export default function SpecimenPage() {
  const radii = byGroup("radius");
  const motion = byGroup("motion");

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <p className={styles.kicker}>Phase 1b · Internal · Not indexed</p>
        <h1 className={styles.title}>Warm Paper — token specimen</h1>
        <p className={styles.lede}>
          Twenty-one tokens, live. They were dormant when this page was built —
          no consumer on any shipping route, this page their only reader, and
          the navigation above and footer below still painted from the old dark
          system. Phase 2 S1 gave them the legal routes and S2 gave them the
          rest, so the chrome around this page is now drawn from the same table
          the page documents. Every swatch, surface and radius here is drawn
          with <code>var(--token)</code> and captioned from a single table, so
          nothing on this page can show a value the stylesheet does not hold.
        </p>

        {/* ── Palette ─────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Palette</h2>
          <p className={styles.sectionNote}>
            Contrast measured against all three grounds. The verdict is derived
            from the ratio beside it rather than stored next to it, so the two
            cannot disagree. Thresholds are WCAG 2.2: 4.5:1 for normal text,
            3:1 for large text (24px, or 18.66px bold) and for a meaningful
            non-text mark under 1.4.11.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Token</th>
                  {GROUNDS.map((g) => (
                    <th key={g.name}>
                      on {g.name.replace("--ground-", "").replace("--ground", "ground")}
                      <br />
                      <span className={styles.tokenValue}>{g.value}</span>
                    </th>
                  ))}
                  <th>Contract</th>
                </tr>
              </thead>
              <tbody>
                {PALETTE.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <span className={styles.swatchCell}>
                        {/* painted from the stylesheet, never from t.value */}
                        <span
                          className={styles.swatch}
                          style={{ background: `var(${t.name})` }}
                        />
                        <span>
                          <span className={styles.tokenName}>{t.name}</span>
                          <br />
                          <span className={styles.tokenValue}>{t.value}</span>
                        </span>
                      </span>
                    </td>
                    {t.ratios!.map((r, i) => (
                      <Cell key={i} ratio={r} />
                    ))}
                    <td className={styles.rowNote}>{t.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── --ink-faint callout ───────────────────────────────────── */}
          <div className={styles.callout}>
            <div className={styles.calloutHead}>
              <span className={styles.calloutToken}>--ink-faint</span>
              <span className={styles.calloutBadge}>NON-TEXT ONLY</span>
              <span className={styles.calloutRatio}>2.41:1 on --ground</span>
            </div>
            <div className={styles.calloutBody}>
              <p>
                It fails twice over. 2.41:1 is below the 4.5:1 that normal text
                needs, and it is also below the 3:1 that WCAG 1.4.11 requires of
                any graphical object carrying meaning. So it clears neither bar,
                and the set of things it may legitimately draw is small:
                hairlines, and states that are not yet drawn.
              </p>
              <p>
                <strong>It may never paint a glyph.</strong> Not a timestamp,
                not a speaker label, not a disabled caption. Anything that reads
                as text takes <code>--ink-soft</code> at 7.31:1.
              </p>
            </div>
            <div className={styles.faintDemo}>
              <div className={styles.faintBad}>
                <span className={styles.demoTag}>--ink-faint · 2.21:1 on sunk · WRONG</span>
                Ravi Kumar · 11:47 PM
              </div>
              <div className={styles.faintGood}>
                <span className={styles.demoTag}>--ink-soft · 6.70:1 on sunk · CORRECT</span>
                Ravi Kumar · 11:47 PM
              </div>
            </div>
          </div>

          {/* ── The note that is a note, not a token ──────────────────── */}
          <div className={styles.markNote}>
            <span className={styles.markNoteLabel}>
              A note, deliberately not a token
            </span>
            Any meaningful non-text mark needs ≥3:1. On these grounds that is{" "}
            <span className={styles.markSwatch} aria-hidden="true" />
            <code>#8A8479</code> or darker. <code>--ink-faint</code> at 2.41:1
            is not one.
            <br />
            <br />
            This is written here rather than declared as{" "}
            <code>--rule-mark</code> because under the ruling below nothing on
            the page is a meaningful non-text mark, so the token would have no
            consumer. A token with no consumer and no rule attached is just a
            hex nobody is accountable for.
          </div>
        </section>

        {/* ── Speaker identity ────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Why --ink-faint has no text use</h2>
          <div className={styles.ruling}>
            <p>
              Speaker identity is carried by two channels, and{" "}
              <strong>neither of them is colour</strong>:
            </p>
            <ul>
              <li>
                the <strong>LABEL</strong> — text, in <code>--ink-soft</code>,
                which passes; and
              </li>
              <li>
                the <strong>INDENT</strong> — position, which needs no contrast
                ratio at all.
              </li>
            </ul>
            <p style={{ marginTop: 12 }}>
              The hairline beside Prantivo&rsquo;s turns is therefore carrying
              nothing required. That is precisely what makes it legitimately
              decorative at <code>--rule</code> (1.18:1) instead of a 1.4.11
              failure — a mark only needs 3:1 when losing it would lose
              information.
            </p>
          </div>
          <div className={styles.turns}>
            <div className={styles.turn}>
              <span className={styles.turnLabel}>Patient</span>
              <span className={styles.turnBody}>
                <span className={styles.te}>రేపు కలుద్దాం</span>
              </span>
              <br />
              <span className={styles.turnTime}>11:47 PM</span>
            </div>
            <div className={`${styles.turn} ${styles.turnAgent}`}>
              <span className={styles.turnLabel}>Prantivo</span>
              <span className={styles.turnBody}>
                <span className={styles.te}>అంతే, ధన్యవాదాలు</span>
              </span>
              <br />
              <span className={styles.turnTime}>11:47 PM</span>
            </div>
          </div>
        </section>

        {/* ── Type scale ──────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Type scale</h2>
          <p className={styles.sectionNote}>
            Every step in Latin and Telugu, plus a mixed-script line.{" "}
            <code>--font-te</code> resolves to a <code>unicode-range</code>
            -scoped Telugu face, so Latin glyphs inside a Telugu run do not come
            from it — they fall down the stack per glyph. The mixed line is
            where that shows, and it is the line worth staring at.
          </p>
          {TYPE_STEPS.map((s) => (
            <div className={styles.typeRow} key={s.token}>
              <div className={styles.typeMeta}>
                {s.token} · tracking {s.track}
              </div>
              <div className={styles.typeSpecimen}>
                <span className={styles.scriptTag}>Latin</span>
                <div className={s.cls}>{s.latin}</div>

                <span className={styles.scriptTag}>Telugu</span>
                <div className={`${s.cls} ${styles.te}`} lang="te">
                  {s.te}
                </div>

                <span className={styles.scriptTag}>
                  Mixed — Telugu, Latin digits, Latin proper noun
                </span>
                <div className={`${s.cls} ${styles.te}`} lang="te">
                  రేపు ఉదయం 10:30 — Prantivo
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* ── Surfaces ────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Surface levels</h2>
          <p className={styles.sectionNote}>
            Three grounds, stacked as they would nest. Sunk is the recessed
            well, ground is the page, raised is the card that sits on it.
          </p>
          <div className={styles.surfaces}>
            <div className={styles.surfaceSunk}>
              <span className={styles.surfaceLabel}>--ground-sunk · #F2EEE8</span>
              <div className={styles.surfaceText}>
                A recessed well. Text here is --ink-strong at 15.79:1.
              </div>
              <div className={styles.surfaceGround}>
                <span className={styles.surfaceLabel}>--ground · #FAF8F5</span>
                <div className={styles.surfaceText}>
                  The page itself. --ink-strong measures 17.22:1.
                </div>
                <div className={styles.surfaceRaised}>
                  <span className={styles.surfaceLabel}>
                    --ground-raised · #FFFFFF
                  </span>
                  <div className={styles.surfaceText}>
                    A card. --ink-strong measures 18.25:1. Its edge is --rule at
                    1.18:1 — decorative, and carrying nothing.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Radii ───────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Radii</h2>
          <p className={styles.sectionNote}>
            Deliberately named <code>--rad-*</code>, not <code>--r-*</code>. The
            existing 4/8/12 scale keeps its names, its values and its three
            divergence rows in brand-values.md; a dormant layer does not
            redefine a token that has consumers.
          </p>
          <div className={styles.radii}>
            {radii.map((r, i) => (
              <div className={styles.radiusItem} key={r.name}>
                <div
                  className={`${styles.radiusBox} ${[styles.rSm, styles.rMd, styles.rLg][i]}`}
                />
                <div className={styles.radiusLabel}>
                  {r.name}
                  <br />
                  {r.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Motion ──────────────────────────────────────────────────── */}
        <section className={styles.section}>
          <h2 className={styles.h2}>Motion</h2>
          <p className={styles.sectionNote}>
            {motion.map((m) => `${m.name}: ${m.value}`).join("  ·  ")}
          </p>
          <div className={styles.motionRow}>
            <div className={styles.motionCard}>
              <span className={styles.surfaceLabel}>@keyframes, on load</span>
              <div className={styles.emergeDemo}>This block emerged.</div>
              <p className={styles.motionCaption}>
                animation: emerge var(--dur-emerge) var(--ease-emerge) both;
                <br />
                Suppressed entirely under prefers-reduced-motion.
              </p>
            </div>
            <div className={styles.motionCard}>
              <span className={styles.surfaceLabel}>:hover transition</span>
              <div className={styles.hoverDemo}>Hover me.</div>
              <p className={styles.motionCaption}>
                transition: background var(--dur-emerge) var(--ease-emerge);
                <br />
                An easing curve, not a spring — nothing here is dragged. See
                docs/design/motion.md §8.
              </p>
            </div>
          </div>
        </section>

        <p className={styles.sectionNote} style={{ marginTop: 64 }}>
          {TOKENS.length} tokens declared in web/app/globals.css. Consumers on
          shipping routes: zero.
        </p>

        {/* ── HERO-1 phase 2 · the Conversation component ───────────────
            Appended below the token specimen, which is left whole above —
            footer line included. Everything from here down is the component,
            not the token table. */}
        <section className={styles.convSection} data-conversation-section>
          <p className={styles.kicker}>
            HERO-1 phase 5 · Playback · English and Telugu · No audio
          </p>
          <h2 className={styles.h2}>Conversation</h2>
          <p className={styles.sectionNote}>
            One stateless component, rendered four times, plus a fifth instance
            a client is playing. <code>&lt;Conversation&gt;</code> still renders
            a frame as a pure function of{" "}
            <code>(turns, activeIndex, revealed)</code> — the thing that walks{" "}
            <code>activeIndex</code> forward over time is a separate file, and
            it and the selector are the only two carrying{" "}
            <code>&quot;use client&quot;</code>.
            These four frames are what it walks through, so they are also its
            pixel-equality baseline: phrase splitting subdivides every turn&rsquo;s
            text into spans, and that must not move a glyph.
          </p>
          <p className={styles.sectionNote}>
            The region is <strong>bottom-anchored, not scrolled</strong> — a
            fixed height, <code>justify-content: flex-end</code> and{" "}
            <code>overflow: hidden</code>. Content overflows upward and clips;
            turns that leave view stay in the DOM and stay in reading order. The
            frame drawn around each region is this page&rsquo;s, not the
            component&rsquo;s: it marks where the fixed height ends so the clip
            is visible rather than inferred.
          </p>
          <p className={styles.sectionNote}>
            Recency is <strong>1.000 / 0.955 / 0.930</strong>, floored — colour
            carries one step and scale carries the rest, so{" "}
            <code>--ink-faint</code> touches no glyph at any position. Only an
            active <em>Prantivo</em> turn takes <code>--ink-strong</code>; a
            patient turn stays <code>--ink-soft</code> whether it is active or
            not. The hairline is Prantivo-only and decorative.
          </p>

          <div className={styles.convStack}>
            {INSTANCES.map((inst) => (
              <div
                key={inst.activeIndex}
                className={styles.convInstance}
                data-active-index={inst.activeIndex}
              >
                <div className={styles.convLabel}>
                  <span className={styles.convIndex}>
                    activeIndex = {inst.activeIndex}
                  </span>
                  <span className={styles.convNote}>{inst.note}</span>
                </div>
                <div className={styles.convFrame}>
                  <Conversation
                    turns={CONVERSATION}
                    activeIndex={inst.activeIndex}
                    record={RECORD}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* ── The fifth instance — interactive ─────────────────────────
              The four above are frames. This one walks them.

              It sits BELOW them and outside their stack so that nothing about
              the four changes: same order, same boxes, same markup, so their
              phase-2 captures stay a usable pixel baseline for the phrase spans
              that now subdivide every turn's text. */}
          <div className={styles.convInstance} data-player-instance style={{ marginTop: 48 }}>
            <div className={styles.convLabel}>
              <span className={styles.convIndex}>
                &lt;LanguageSelector /&gt; + &lt;ConversationPlayer /&gt;
              </span>
              <span className={styles.convNote}>
                playback — idle · playing · paused · complete · two languages
              </span>
            </div>
            <div className={styles.convFrame} style={{ padding: 16 }}>
              <LanguageSwitchedConversation
                langs={LANGUAGES}
                conversations={CONVERSATIONS}
                initial="te"
                record={RECORD}
              />
            </div>
          </div>

          <p className={styles.sectionNote} style={{ marginTop: 32 }}>
            The frame around the player encloses the control as well as the
            region, so unlike the four above it is not a marker for where the
            fixed height ends — the four static instances keep that job.
            Playback walks <code>activeIndex</code> 0 → 6 in{" "}
            <strong>13.2 seconds</strong>, from one constant:{" "}
            <code>phraseDuration = max(550ms, chars / CPS × 1000)</code>, plus
            220ms of stillness after each turn. <code>CPS</code> is the only
            per-language number and lives in <code>cadence.ts</code>:{" "}
            <strong>32</strong> for Telugu, <strong>30</strong> for English,
            tuned so the two walks take the same time —{" "}
            <code>13207.5ms</code> and <code>13203ms</code>, four milliseconds
            apart across thirteen seconds. Hindi lands in 4b.
          </p>
          <p className={styles.sectionNote}>
            <strong>Emergence is Prantivo-only.</strong> A patient turn appears
            whole, in one 150ms fade — the asymmetry is the content:{" "}
            <em>Prantivo speaks</em>, the patient&rsquo;s message{" "}
            <em>arrived</em>. Only <code>t1</code> and <code>t3</code> visibly
            unfold, because they are the only Prantivo turns with more than one
            phrase, and they are the two turns where the receptionist is doing
            work. An un-emerged phrase is transparent rather than absent, so it
            holds its space and nothing already on screen moves when it lands.
          </p>

          <p className={styles.sectionNote} style={{ marginTop: 32 }}>
            The record on the last instance is read from{" "}
            <code>public/demo/fixture.json</code>, not typed into the component:{" "}
            <code>Dr. Rao</code>, <code>9:00 AM</code> and <code>booked</code>{" "}
            are that file&rsquo;s <code>appointment</code> block.{" "}
            <code>Tomorrow</code> is authored — it is the dialogue&rsquo;s own
            relative framing. The fixture&rsquo;s <code>date</code> is
            deliberately not rendered: it is 2026-07-18, and a card reading
            &ldquo;Saturday, 18 July&rdquo; beside a thread saying{" "}
            <span lang="te">రేపు</span> (&ldquo;tomorrow&rdquo;) is incoherent.
          </p>
        </section>
      </div>
    </main>
  );
}
