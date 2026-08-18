import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { waLink, waMessages } from "@/lib/siteConfig";
import { to12Hour } from "./conversation/Conversation";
import { LanguageSwitchedConversation } from "./conversation/LanguageSelector";
import {
  getConversation,
  LANGUAGES,
  type LangCode,
  type Turn,
} from "./conversation";
import fixture from "../../../public/demo/fixture.json";
import styles from "./Hero.module.css";

/* ── THE SERVER→CLIENT BOUNDARY ───────────────────────────────────────────────
 *
 * HERO-1 phase 5. `HeroChat` — a "use client" component that carried its own
 * six hand-typed messages and its own English glosses — is gone; the hero now
 * mounts the conversation module, and the module's own boundary rules apply
 * here exactly as they do on /specimen.
 *
 * THIS FILE IS STILL A SERVER COMPONENT, and that is what makes the rest true.
 * It reads the fixture, resolves every language, and hands three strings across
 * the boundary. `LanguageSwitchedConversation` is the client half; nothing it
 * imports imports this file, so the fixture never enters a browser chunk.
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

/* Every language LANGUAGES offers, resolved on the server. Built from the same
 * list the selector renders its segments from, so a segment cannot exist
 * without strings behind it — the /specimen page does this identically, and
 * for the same reason. */
const CONVERSATIONS = Object.fromEntries(
  LANGUAGES.map((code) => [code, getConversation(code)])
) as Partial<Record<LangCode, Turn[]>>;

const RECORD = {
  status: fixture.appointment.status,
  time: to12Hour(fixture.appointment.time),
  doctor: fixture.appointment.doctor_name,
} as const;

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
        <div className={styles.chatStage}>
          <LanguageSwitchedConversation
            langs={LANGUAGES}
            conversations={CONVERSATIONS}
            initial="te"
            record={RECORD}
          />
          {/* THE HONESTY LABEL. Carried over from HeroChat, by deletion only —
              no word here was authored this phase. What was removed is the two
              clauses that described HeroChat's rendering rather than the
              product: ", here in Telugu" (the reader can now choose) and "— the
              replies are translated beneath" (there is no gloss line; there is
              a language selector instead). Both would have been false the
              moment the component underneath changed, and a hero that quietly
              drops its own disclosure while gaining a booking-confirmation
              animation is the one dishonest pixel on a careful page.

              It is a <p>, not an aria-label. HeroChat's disclosure was BOTH: a
              visible caption and an aria-label on a role="img" wrapper that hid
              the whole thread from assistive technology. The conversation is
              real content now — DOM order, aria-live, a readable confirmation
              record — so there is nothing to summarise for a screen reader and
              no wrapper to hang a label on. This sentence is read as the text
              it is. */}
          <p className={styles.chatCaption}>
            An example of Prantivo booking a patient appointment on WhatsApp. It
            also answers in Hindi and English, and a staff member can take over
            the chat at any point.
          </p>
        </div>
      </div>
    </section>
  );
}
