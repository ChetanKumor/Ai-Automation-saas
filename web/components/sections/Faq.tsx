"use client";

import { useState } from "react";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/Button";
import { FAQ_ITEMS } from "./faqData";
import styles from "./Faq.module.css";

export function Faq() {
  const [openItems, setOpenItems] = useState<Set<number>>(() => new Set([0]));

  function toggle(index: number) {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  return (
    <section className={styles.faq}>
      <div className="wrap">
        <div className={styles.faqGrid}>
          <Reveal className={styles.faqHead}>
            <Eyebrow variant="bar">FAQ</Eyebrow>
            <h2>Frequently asked questions</h2>
            <p>
              Short answers to what clinics and businesses ask most. Still
              unsure? Ask us directly.
            </p>
            <div className={styles.faqCta}>
              <Button variant="primary">Book a demo</Button>
              <Button variant="secondary">Talk to us</Button>
            </div>
          </Reveal>

          <Reveal className={styles.faqList} style={{ transitionDelay: ".08s" }}>
            {FAQ_ITEMS.map((item, i) => {
              const isOpen = openItems.has(i);
              const panelId = `faq-a-${i}`;
              return (
                <div
                  key={i}
                  className={`${styles.faqItem}${isOpen ? ` ${styles.open}` : ""}`}
                >
                  <button
                    className={styles.faqQ}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggle(i)}
                  >
                    {item.question}
                    <svg
                      className={styles.faqChevron}
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  <div className={styles.faqAWrap}>
                    <div className={styles.faqAInner}>
                      <div className={styles.faqA} id={panelId}>
                        {item.answer}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </Reveal>
        </div>
      </div>
    </section>
  );
}
