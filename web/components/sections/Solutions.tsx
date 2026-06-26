import { type ReactNode } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./Solutions.module.css";

interface Vertical {
  icon: ReactNode;
  name: string;
  desc: string;
  exchange: { inbound: string; outbound: string };
  delay?: number;
}

const VERTICALS: Vertical[] = [
  {
    icon: (
      <svg className={styles.vcIcon} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    name: "Clinics & Healthcare",
    desc: "An AI receptionist for any practice — dental, skin, physio, diagnostics, and more. It books appointments, answers treatment and timing questions, and sends reminders, so the front desk stops being the bottleneck.",
    exchange: {
      inbound: "Do you have anything for a consultation this week?",
      outbound:
        "Yes — Dr. Mehta has Thursday 11:00 AM or Friday 4:30 PM. Which suits you? I'll send a reminder the day before.",
    },
  },
  {
    icon: (
      <svg className={styles.vcIcon} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
    name: "Real Estate",
    desc: "Qualify property enquiries the moment they arrive, capture budget and location, and route serious buyers to an agent. Leads land in the CRM, not a notebook.",
    exchange: {
      inbound: "Is the 2BHK in Gachibowli still available?",
      outbound:
        "Yes, it's available. What's your budget range, and when are you looking to move? I'll have an agent call you with options that fit.",
    },
    delay: 0.08,
  },
  {
    icon: (
      <svg className={styles.vcIcon} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="23 6 13.5 16.5 8.5 11.5 1 19" />
        <polyline points="17 6 23 6 23 12" />
      </svg>
    ),
    name: "Finance",
    desc: "For advisors, lenders, and insurance — qualify enquiries, answer common questions, and book consultations, without anyone waiting on hold. The right specialist gets a warm, qualified lead.",
    exchange: {
      inbound: "I'm looking for a home loan — what can I get?",
      outbound:
        "I'll set up a call with an advisor who can walk you through your options. Roughly how much are you looking to borrow, and is this a new purchase?",
    },
    delay: 0.16,
  },
];

const BREADTH_TAGS = [
  "Salons & spas",
  "Gyms & fitness",
  "Diagnostic labs",
  "Coaching & tutoring",
  "Home services",
  "Dealerships",
];

export function Solutions() {
  return (
    <section className={styles.sol}>
      <div className="wrap">
        <Reveal className={styles.solHead}>
          <Eyebrow variant="bar">Solutions</Eyebrow>
          <h2 className={styles.h2}>
            Made for your industry. Not limited to one.
          </h2>
          <p className={styles.sub}>
            If your customers message you to book an appointment, ask a
            question, or start a deal, Zyon handles it. Here&rsquo;s how it
            shows up across a few industries — the platform underneath is the
            same.
          </p>
        </Reveal>

        <div className={styles.verticals}>
          {VERTICALS.map((v) => (
            <Reveal
              key={v.name}
              className={styles.vc}
              style={v.delay ? { transitionDelay: `${v.delay}s` } : undefined}
            >
              {v.icon}
              <div className={styles.vcName}>{v.name}</div>
              <p className={styles.vcDesc}>{v.desc}</p>
              <div className={styles.ex}>
                <div className={styles.bIn}>{v.exchange.inbound}</div>
                <div className={styles.bOut}>{v.exchange.outbound}</div>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal
          className={styles.breadth}
          style={{ transitionDelay: "0.1s" }}
        >
          <div className={styles.breadthLabel}>
            And any business that books appointments or fields enquiries.{" "}
            <span>Same platform, configured to you.</span>
          </div>
          <div className={styles.tags}>
            {BREADTH_TAGS.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>
        </Reveal>

        <Reveal
          className={styles.solCta}
          style={{ transitionDelay: "0.15s" }}
        >
          <Button variant="primary">Book a demo</Button>
          <Button variant="ghost">Explore the platform →</Button>
        </Reveal>
      </div>
    </section>
  );
}
