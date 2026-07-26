"use client";

import { useEffect, useRef, useCallback } from "react";
import styles from "./Hero.module.css";

// The mockup plays in Telugu because the subhead one column to the left claims
// Telugu, and this is the one claim the product can prove instantly and for free.
// A prospect who has to take it on faith is being asked for the wrong thing.
//
// Provenance, kept straight. The first two lines are REAL, copied verbatim from
// public/demo/fixture.json: the customer line is Sarvam STT output on
// founder-recorded audio, the reply is output of the same brain the live route
// runs. The other four are hand-authored illustrative copy — exactly what that
// fixture's own WhatsApp side is (see its `provenance.whatsapp`). Nothing here is
// presented as a capture, and the real pair must not be edited: re-capture it or
// leave it alone.
//
// `te` is the message. `en` is a translation shown beneath the receptionist's
// replies so a prospect who does not read Telugu can still follow the booking;
// the customer's own lines carry none, since the replies restate what was asked.
const MESSAGES = [
  {
    dir: "in",
    te: "హాయ్, నాకు అపాయింట్మెంట్ బుక్ చేద్దామని ఉంది. డాక్టర్ ఎప్పుడు అవైలబుల్ గా ఉన్నారు రేపు?",
    en: null,
    time: "9:14 AM",
  },
  {
    dir: "out",
    te: "నమస్తే! రేపు, అంటే శనివారం, డాక్టర్ రావు ఉదయం 9 గంటల నుండి సాయంత్రం 5:30 వరకు అందుబాటులో ఉన్నారు. మీకు ఏ సమయం కావాలి?",
    en: "Namaste! Tomorrow — Saturday — Dr. Rao is available from 9:00 AM to 5:30 PM. What time would you like?",
    time: "9:14 AM",
  },
  {
    dir: "in",
    te: "ఉదయం 9 గంటలకు బుక్ చేయండి.",
    en: null,
    time: "9:15 AM",
  },
  {
    dir: "out",
    te: "బుక్ అయింది — రేపు ఉదయం 9 గంటలకు డాక్టర్ రావుతో. ఒక రోజు ముందు రిమైండర్ పంపుతాను. ఇంకా ఏమైనా కావాలా?",
    en: "Booked — tomorrow at 9:00 AM with Dr. Rao. I'll send a reminder the day before. Anything else?",
    time: "9:15 AM",
  },
  {
    dir: "in",
    te: "అంతే, ధన్యవాదాలు.",
    en: null,
    time: "9:16 AM",
  },
  {
    dir: "out",
    te: "రేపు కలుద్దాం!",
    en: "See you tomorrow!",
    time: "9:16 AM",
  },
] as const;

export function HeroChat() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const bubblesRef = useRef<(HTMLDivElement | null)[]>([]);
  const timersRef = useRef<number[]>([]);

  const reset = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    bubblesRef.current.forEach((b) => b?.classList.remove(styles.bubbleShow));
    statusRef.current?.classList.remove(styles.typing);
  }, []);

  const showAll = useCallback(() => {
    bubblesRef.current.forEach((b) => b?.classList.add(styles.bubbleShow));
  }, []);

  const play = useCallback(() => {
    reset();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      showAll();
      return;
    }

    let t = 300;
    bubblesRef.current.forEach((b) => {
      if (!b) return;
      const isAI = b.dataset.dir === "out";
      if (isAI) {
        timersRef.current.push(
          window.setTimeout(() => statusRef.current?.classList.add(styles.typing), t)
        );
        t += 850;
        timersRef.current.push(
          window.setTimeout(() => {
            statusRef.current?.classList.remove(styles.typing);
            b.classList.add(styles.bubbleShow);
            bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
          }, t)
        );
        t += 750;
      } else {
        timersRef.current.push(
          window.setTimeout(() => {
            b.classList.add(styles.bubbleShow);
            bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
          }, t)
        );
        t += 650;
      }
    });
  }, [reset, showAll]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    let played = false;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            if (!played || e.intersectionRatio > 0.6) {
              play();
              played = true;
            }
          }
        });
      },
      { threshold: [0.3, 0.6] }
    );

    io.observe(body);
    return () => {
      io.disconnect();
      timersRef.current.forEach(clearTimeout);
    };
  }, [play]);

  return (
    <div className={styles.chatStage}>
      <div
        className={styles.wa}
        role="img"
        aria-label="An example WhatsApp conversation, in Telugu, where the Prantivo AI receptionist books a dental appointment for a customer. Each reply is shown in Telugu with an English translation beneath it."
      >
        <div className={styles.waHead}>
          <div className={styles.waAvatar}>L</div>
          <div>
            <div className={styles.waName}>Lakeview Dental</div>
            <div className={styles.waStatus} ref={statusRef}>
              <span className={styles.stOnline}>online</span>
              <span className={styles.stTyping}>
                typing<i /><i /><i />
              </span>
            </div>
          </div>
        </div>
        <div className={styles.waBody} ref={bodyRef}>
          {MESSAGES.map((msg, i) => (
            <div
              key={i}
              ref={(el) => {
                bubblesRef.current[i] = el;
              }}
              data-dir={msg.dir}
              className={`${styles.bubble} ${msg.dir === "in" ? styles.bubbleIn : styles.bubbleOut}`}
            >
              {/* lang="te" sits on the Telugu element itself, not on an ancestor
                  that also holds English — the pattern from public/demo/app.js:105.
                  It selects the Telugu face and tells a screen reader which
                  language to pronounce. */}
              <span lang="te" className={styles.bubbleTe}>
                {msg.te}
              </span>
              {msg.en !== null && (
                <span className={styles.bubbleEn}>{msg.en}</span>
              )}
              <span className={styles.time}>{msg.time}</span>
            </div>
          ))}
        </div>
      </div>
      <p className={styles.waCaption}>
        An example of the AI receptionist booking an appointment on WhatsApp,
        here in Telugu — the replies are translated beneath. It also answers in
        Hindi and English, and a staff member can take over the chat at any
        point.
      </p>
    </div>
  );
}
