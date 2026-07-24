import { type ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
import { waLink, waMessages } from "@/lib/siteConfig";
import styles from "./Platform.module.css";

interface Module {
  tag?: string;
  icon: ReactNode;
  name: string;
  desc: string;
  live?: boolean;
  soon?: boolean;
  delay?: number;
}

const MODULES: Module[] = [
  {
    tag: "Where clinics start",
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
      </svg>
    ),
    name: "Answers on WhatsApp",
    desc: "Replies to every message on your clinic's own WhatsApp number, 24/7 — answering questions and qualifying new patients.",
    live: true,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
    name: "Books appointments",
    desc: "Offers open slots, books the appointment, confirms it, and sends a reminder before the visit.",
    live: true,
    delay: 0.06,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    name: "Remembers your patients",
    desc: "Recognises returning patients and recalls the earlier conversation, so no one has to repeat themselves.",
    live: true,
    delay: 0.12,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    ),
    name: "Hands off to your team",
    desc: "When a chat needs a person, your staff take over in the same thread — the AI stays silent until you hand it back.",
    live: true,
    delay: 0.06,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    ),
    name: "AI voice calling",
    desc: "Answers and places calls in your clinic's voice.",
    soon: true,
    delay: 0.12,
  },
];

export function Platform() {
  return (
    <section id="platform" className={styles.platform}>
      <div className="wrap">
        <Reveal className={styles.platformHead}>
          <Eyebrow variant="bar">What it does</Eyebrow>
          <h2 className={styles.h2}>
            Everything your front desk does, on WhatsApp
          </h2>
          <p className={styles.sub}>
            One receptionist that answers, books, and remembers — on your
            clinic&rsquo;s own number. When a conversation needs a person, your
            team steps into the same chat.
          </p>
        </Reveal>

        <div className={styles.modules}>
          {MODULES.map((m) => (
            <Reveal
              key={m.name}
              className={`${styles.mod}${m.soon ? ` ${styles.soon}` : ""}`}
              style={m.delay ? { transitionDelay: `${m.delay}s` } : undefined}
            >
              {m.tag && <span className={styles.modTag}>{m.tag}</span>}
              <div className={styles.modTop}>
                {m.icon}
                <span className={styles.modStatus}>
                  {m.live ? (
                    <>
                      <span className={styles.live} />
                      Live
                    </>
                  ) : (
                    "Coming soon"
                  )}
                </span>
              </div>
              <div className={styles.modName}>{m.name}</div>
              <p className={styles.modDesc}>{m.desc}</p>
            </Reveal>
          ))}
        </div>

        <Reveal
          className={styles.base}
          style={{ transitionDelay: "0.1s" }}
        >
          <div className={styles.baseInner}>
            <span className={styles.baseLabel}>
              <span className={styles.core} />
              Configured to your clinic
            </span>
            <p className={styles.baseCopy}>
              <b>Set up to how your clinic runs.</b> Your prompts, your booking
              rules, your WhatsApp number — and every clinic&rsquo;s data stays
              isolated.
            </p>
            <div className={styles.chips}>
              <span className={styles.chip}>Your own number</span>
              <span className={styles.chip}>Your booking rules</span>
              <span className={styles.chip}>Per-clinic isolation</span>
              <span className={styles.chip}>Configured, not coded</span>
            </div>
          </div>
        </Reveal>

        <Reveal
          className={styles.platformCta}
          style={{ transitionDelay: "0.15s" }}
        >
          <Button
            variant="primary"
            href={waLink(waMessages.demo)}
            aria-label="Book a demo on WhatsApp"
          >
            Book a demo
          </Button>
          <Button variant="ghost" href="#how-it-works">
            See how it works →
          </Button>
        </Reveal>
      </div>
    </section>
  );
}
