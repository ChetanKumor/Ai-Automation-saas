import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./Problem.module.css";

interface Enquiry {
  time: string;
  tag: string;
  msg: string;
  foot: { tick: boolean; text: string };
  missed?: boolean;
  delay?: number;
}

const ENQUIRIES: Enquiry[] = [
  {
    time: "11:42 PM",
    tag: "After hours",
    msg: "Do you have any appointments this week?",
    foot: { tick: true, text: "Delivered · unread" },
  },
  {
    time: "6:47 AM",
    tag: "Before open",
    msg: "How much for a cleaning?",
    foot: { tick: true, text: "Delivered · unread" },
    delay: 0.08,
  },
  {
    time: "1:15 PM",
    tag: "In a chair",
    msg: "Missed voice call",
    foot: { tick: false, text: "No callback yet" },
    missed: true,
    delay: 0.16,
  },
  {
    time: "9:58 PM",
    tag: "After hours",
    msg: "My tooth is really hurting — can I come tomorrow?",
    foot: { tick: true, text: "Delivered · unread" },
    delay: 0.24,
  },
];

export function Problem() {
  return (
    <section className={styles.problem}>
      <div className="wrap">
        <Reveal className={styles.problemHead}>
          <Eyebrow variant="bar">The status quo</Eyebrow>
          <h2 className={styles.h2}>
            Your customers are on WhatsApp.
            <br />
            <span className={styles.muted}>
              The front desk can&rsquo;t keep up.
            </span>
          </h2>
          <p className={styles.problemBody}>
            Enquiries arrive after hours and during appointments. Calls go to
            voicemail. A new lead waits unread until someone has a free minute —
            and by then they&rsquo;ve messaged another clinic. Your staff answer
            the same questions all day instead of doing their actual work.
          </p>
        </Reveal>

        <div className={styles.enquiries}>
          {ENQUIRIES.map((enq) => (
            <Reveal
              key={enq.time}
              className={`${styles.enq}${enq.missed ? ` ${styles.missed}` : ""}`}
              style={enq.delay ? { transitionDelay: `${enq.delay}s` } : undefined}
            >
              <div className={styles.enqTop}>
                <span className={styles.enqTime}>{enq.time}</span>
                <span className={styles.enqTag}>{enq.tag}</span>
              </div>
              <div className={styles.enqMsg}>{enq.msg}</div>
              <div className={styles.enqFoot}>
                {enq.foot.tick && <span className={styles.tick}>✓✓</span>}
                {enq.foot.text}
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal
          className={styles.silenceNote}
          style={{ transitionDelay: "0.3s" }}
        >
          <span>
            No green. No replies. Every one of these is a customer who will
            message someone else.
          </span>
          <span className={styles.ln} />
        </Reveal>
      </div>
    </section>
  );
}
