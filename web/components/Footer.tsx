import Link from "next/link";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerMain}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.brand} aria-label="Prantivo home">
              <svg
                className={styles.mark}
                viewBox="0 0 22 22"
                aria-hidden="true"
              >
                <rect x="2" y="2" width="18" height="18" rx="5" />
                <circle cx="7.5" cy="11" r="1.5" />
                <circle cx="11" cy="11" r="1.5" />
                <circle cx="14.5" cy="11" r="1.5" />
              </svg>
              Prantivo
            </Link>
            <p className={styles.footerTag}>
              The AI receptionist for dental clinics, on WhatsApp.
            </p>
          </div>

          <div className={styles.footerCols}>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Product</div>
              <a href="#platform">AI WhatsApp receptionist</a>
              <a href="#how-it-works">Appointment booking</a>
            </div>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Company</div>
              <a href="#pricing">Pricing</a>
              <a href="#faq">FAQ</a>
            </div>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Legal</div>
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/terms">Terms of Service</Link>
              <Link href="/data-deletion">Data Deletion</Link>
              <Link href="/acceptable-use">Acceptable Use</Link>
            </div>
          </div>
        </div>

        <div className={styles.footerBottom}>
          {/* "Prantivo" is the trading name. Replace with the registered legal entity name before Meta submission if it differs. */}
          <div className={styles.copy}>
            &copy; 2026 <span className={styles.copyEntity}>Prantivo</span> &middot; India
          </div>
          <p className={styles.trademark}>
            Prantivo is built on the WhatsApp Business Platform. WhatsApp is a
            trademark of Meta Platforms, Inc., used for identification only.
          </p>
        </div>
      </div>
    </footer>
  );
}
