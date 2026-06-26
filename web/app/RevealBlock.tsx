"use client";

import { useScrollReveal } from "@/lib/useScrollReveal";
import styles from "./page.module.css";

export function RevealBlock() {
  const ref = useScrollReveal<HTMLDivElement>();

  return (
    <div ref={ref} className={styles.revealDemo}>
      <div className={styles.revealLabel}>
        useScrollReveal · IntersectionObserver · threshold 0.16
      </div>
      <div className={styles.revealContent}>This element revealed on scroll</div>
    </div>
  );
}
