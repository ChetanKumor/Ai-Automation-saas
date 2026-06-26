"use client";

import { useEffect, useRef, useCallback } from "react";
import styles from "./Hero.module.css";

const MESSAGES = [
  { text: "Hi, do you have an appointment this week? I've had a toothache since yesterday.", dir: "in", time: "9:14 AM" },
  { text: "Yes. Dr. Rao has Thursday at 11:00 AM or Friday at 4:30 PM. Which suits you?", dir: "out", time: "9:14 AM" },
  { text: "Thursday 11 works.", dir: "in", time: "9:15 AM" },
  { text: "Booked. Thursday, 11:00 AM with Dr. Rao. I'll send a reminder the day before. Anything else?", dir: "out", time: "9:15 AM" },
  { text: "That's all, thanks.", dir: "in", time: "9:16 AM" },
  { text: "See you Thursday.", dir: "out", time: "9:16 AM" },
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
        aria-label="A WhatsApp conversation where the Zyon AI receptionist books a dental appointment for a customer."
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
              {msg.text}
              <span className={styles.time}>{msg.time}</span>
            </div>
          ))}
        </div>
      </div>
      <p className={styles.waCaption}>
        The AI receptionist booking an appointment on WhatsApp. A staff member
        can take over the chat at any point.
      </p>
    </div>
  );
}
