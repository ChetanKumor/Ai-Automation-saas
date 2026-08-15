import type { Metadata } from "next";
import styles from "./specimen.module.css";
import { TOKENS, GROUNDS, PALETTE, byGroup, verdict, type Verdict } from "./tokens";

/* ============================================================================
 * Phase 1b token specimen. Server component — no "use client", no hooks, no
 * client island. Everything below is static markup plus CSS.
 *
 * It lives inside the (marketing) route group DELIBERATELY. Nav and Footer
 * render above and below from the old dark tokens, so the two systems sit on
 * one page and dormancy is something you can see rather than something the
 * commit message asserts.
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

export default function SpecimenPage() {
  const radii = byGroup("radius");
  const motion = byGroup("motion");

  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <p className={styles.kicker}>Phase 1b · Internal · Not indexed</p>
        <h1 className={styles.title}>Warm Paper — token specimen</h1>
        <p className={styles.lede}>
          Twenty-one tokens, dormant. Nothing on any shipping route consumes
          them; this page is their only reader, which is why the navigation
          above and the footer below are still painted from the old dark
          system. Every swatch, surface and radius here is drawn with{" "}
          <code>var(--token)</code> and captioned from a single table, so
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
      </div>
    </main>
  );
}
