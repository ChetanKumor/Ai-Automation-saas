import Link from "next/link";
import styles from "./legal.module.css";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <div className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/" className={styles.brand}>
            <svg className={styles.mark} viewBox="0 0 22 22" aria-hidden="true">
              <rect x="2" y="2" width="18" height="18" rx="5" />
              <circle cx="7.5" cy="11" r="1.5" />
              <circle cx="11" cy="11" r="1.5" />
              <circle cx="14.5" cy="11" r="1.5" />
            </svg>
            Zyon
          </Link>
          <Link href="/" className={styles.back}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back to home
          </Link>
        </div>
      </div>

      {children}

      <footer className={styles.legalFoot}>
        <div className={styles.legalFootInner}>
          <div className={styles.legalLinks}>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
            <Link href="/data-deletion">Data Deletion</Link>
            <Link href="/acceptable-use">Acceptable Use</Link>
          </div>
          <div className={styles.copy}>&copy; 2026 Zyon &middot; India</div>
        </div>
      </footer>
    </>
  );
}
