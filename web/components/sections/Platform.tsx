import { type ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
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
    tag: "Most start here",
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
      </svg>
    ),
    name: "AI WhatsApp Receptionist",
    desc: "Answers enquiries, qualifies leads, and books appointments on WhatsApp, 24/7.",
    live: true,
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
    name: "Workflow Automation",
    desc: "Turn an incoming message into actions — reminders, follow-ups, handoffs, record updates — by your rules.",
    live: true,
    delay: 0.06,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 3l1.9 5.8L20 10l-5.8 1.9L12 18l-1.9-5.8L4 10l5.8-1.9z" />
      </svg>
    ),
    name: "AI Agents",
    desc: "Task-specific agents that handle work end to end, grounded in your business's own information.",
    live: true,
    delay: 0.12,
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
    name: "CRM",
    desc: "Every contact, conversation, and lead in one place, updated automatically as people message you.",
    live: true,
    delay: 0.06,
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
    name: "Appointment Management",
    desc: "Booking, confirmations, and reminders, kept in sync without manual entry.",
    live: true,
    delay: 0.12,
  },
  {
    icon: (
      <svg className={styles.modIcon} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    ),
    name: "AI Voice Calling",
    desc: "AI that answers and places calls in your business's voice.",
    soon: true,
    delay: 0.18,
  },
];

export function Platform() {
  return (
    <section className={styles.platform}>
      <div className="wrap">
        <Reveal className={styles.platformHead}>
          <Eyebrow variant="bar">The platform</Eyebrow>
          <h2 className={styles.h2}>
            One platform for your customer operations
          </h2>
          <p className={styles.sub}>
            Five products on shared infrastructure, configured to your business.
            The AI receptionist is where most clinics start. The rest is already
            here when you need it.
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
              One platform underneath
            </span>
            <p className={styles.baseCopy}>
              <b>One system underneath all of it.</b> Add a product when
              you&rsquo;re ready — nothing to re-integrate.
            </p>
            <div className={styles.chips}>
              <span className={styles.chip}>Multi-tenant routing</span>
              <span className={styles.chip}>Shared AI engine</span>
              <span className={styles.chip}>One data layer</span>
              <span className={styles.chip}>Per-business isolation</span>
            </div>
          </div>
        </Reveal>

        <Reveal
          className={styles.platformCta}
          style={{ transitionDelay: "0.15s" }}
        >
          <Button variant="primary">Explore the platform</Button>
          <Button variant="ghost">Book a demo →</Button>
        </Reveal>
      </div>
    </section>
  );
}
