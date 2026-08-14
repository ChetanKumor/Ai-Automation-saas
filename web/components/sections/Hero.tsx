import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { waLink, waMessages } from "@/lib/siteConfig";
import { HeroChat } from "./HeroChat";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <Eyebrow className={`${styles.reveal} ${styles.d1}`}>
          For clinics in Hyderabad
        </Eyebrow>

        <h1 className={styles.h1}>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d2}`}>
              Booked before
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d3}`}>
              they message
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d4}`}>
              another clinic.
            </span>
          </span>
        </h1>

        <p className={`${styles.sub} ${styles.reveal} ${styles.d5}`}>
          Patients message your clinic at 11 PM, during a procedure, on a
          Sunday. Prantivo answers in seconds — in Telugu, Hindi or English —
          quotes your prices, and books the appointment. On your clinic&rsquo;s
          own WhatsApp number.
        </p>

        <div className={`${styles.heroCta} ${styles.reveal} ${styles.d6}`}>
          {/* Primary keeps its existing wa.me href on purpose. There is no WABA
              yet (external clock C-3, docs/os/clocks.md), so a deep link to a
              number that cannot answer would be a dead primary CTA — worse than
              the founder's own number, which does answer. Revisit when C-3
              clears. */}
          <Button
            variant="primary"
            href={waLink(waMessages.demo)}
            aria-label="Watch it book an appointment in Telugu — message us on WhatsApp"
          >
            Watch it book an appointment in Telugu →
          </Button>
          <Button variant="secondary" href="#pricing">
            See what it costs
          </Button>
        </div>

        <p className={`${styles.heroMicro} ${styles.reveal} ${styles.d6}`}>
          Message it in Telugu. It answers in Telugu.
        </p>
      </div>

      <div className={styles.chatCol}>
        <HeroChat />
      </div>
    </section>
  );
}
