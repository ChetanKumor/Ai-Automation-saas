import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./Why.module.css";

export function Why() {
  return (
    <section className={styles.why}>
      <div className="wrap">
        <div className={styles.whyGrid}>
          <Reveal className={styles.whyHead}>
            <Eyebrow variant="bar">Why Zyon</Eyebrow>
            <h2>The difference is in the architecture</h2>
            <p>
              Anyone can bolt a chatbot onto WhatsApp. What you build it on is
              what decides whether it&apos;s safe, private, and yours.
            </p>
          </Reveal>

          <div className={styles.pillars}>
            {/* Pillar 1 — AI and humans */}
            <Reveal className={styles.pillar}>
              <svg
                className={styles.pillarIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <path d="M6 9v3a3 3 0 0 0 3 3h6" />
                <path d="M15 9h3a3 3 0 0 1 0 6" />
              </svg>
              <div>
                <div className={styles.pillarTitle}>AI and humans, together</div>
                <p className={styles.pillarDesc}>
                  The AI handles volume. Your team handles the moments that
                  matter. Same conversation, no second tool to check.
                </p>
              </div>
              <div className={styles.mp}>
                <div className={styles.mpThread}>
                  <span className={styles.mpPill}>AI</span>
                  <span className={styles.mpSwap}>⇄</span>
                  <span className={`${styles.mpPill} ${styles.mpPillSolid}`}>
                    You
                  </span>
                </div>
                <span className={styles.mpNote}>one thread</span>
              </div>
            </Reveal>

            {/* Pillar 2 — Official platform */}
            <Reveal className={styles.pillar} style={{ transitionDelay: ".08s" }}>
              <svg
                className={styles.pillarIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <polyline points="9 12 11 14 15 10" />
              </svg>
              <div>
                <div className={styles.pillarTitle}>
                  The official WhatsApp Business Platform
                </div>
                <p className={styles.pillarDesc}>
                  Your messages run on Meta&apos;s official WhatsApp Cloud API —
                  not an unofficial workaround that can get your number blocked.
                </p>
              </div>
              <div className={styles.mp}>
                <div className={`${styles.mpLine} ${styles.mpGood}`}>
                  <span className="ic">✓</span>Official Cloud API
                </div>
                <div className={`${styles.mpLine} ${styles.mpBad}`}>
                  <span className="ic">✕</span>
                  <span className="txt">Unofficial bot</span> · banned
                </div>
              </div>
            </Reveal>

            {/* Pillar 3 — Your number, your data */}
            <Reveal className={styles.pillar} style={{ transitionDelay: ".16s" }}>
              <svg
                className={styles.pillarIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <div>
                <div className={styles.pillarTitle}>Your number, your data</div>
                <p className={styles.pillarDesc}>
                  Zyon works on your existing WhatsApp Business number. Every
                  business is isolated; your conversations and contacts are never
                  shared with anyone else on the platform.
                </p>
              </div>
              <div className={styles.mp}>
                <div className={styles.mpIso}>
                  <span className={styles.mpBox} />
                  <span className={`${styles.mpBox} ${styles.mpBoxYou}`}>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <span className={styles.mpBox} />
                </div>
                <span className={styles.mpNote}>isolated per business</span>
              </div>
            </Reveal>

            {/* Pillar 4 — Configured, not coded */}
            <Reveal className={styles.pillar} style={{ transitionDelay: ".24s" }}>
              <svg
                className={styles.pillarIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              <div>
                <div className={styles.pillarTitle}>Configured, not coded</div>
                <p className={styles.pillarDesc}>
                  Your prompts, rules, and workflows are settings you change in
                  the dashboard — not a developer ticket.
                </p>
              </div>
              <div className={styles.mp}>
                <div className={styles.mpToggle}>
                  <span className={styles.toggle} />
                  <span className={styles.mpNote}>in the dashboard</span>
                </div>
                <div className={`${styles.mpLine} ${styles.mpBad}`}>
                  <span className="ic">✕</span>
                  <span className="txt">dev ticket</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
