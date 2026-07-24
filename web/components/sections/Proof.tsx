import styles from "./Proof.module.css";

// Don't add a Meta Partner badge yet
export function Proof() {
  return (
    <div className={styles.proof}>
      <div className={styles.proofInner}>
        <div className={styles.proofItem}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          Official WhatsApp Business Platform
        </div>
        <div className={styles.proofItem}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
            <circle cx="9" cy="7" r="3" />
            <path d="M23 21v-2a4 4 0 00-3-3.87" />
          </svg>
          AI and your team share one inbox
        </div>
        <div className={styles.proofItem}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          Every business isolated · your data stays yours
        </div>
        <div className={styles.proofItem}>
          <span className={styles.accentDot} />
          Answers in Telugu, Hindi &amp; English · AI voice calling soon
        </div>
      </div>
    </div>
  );
}
