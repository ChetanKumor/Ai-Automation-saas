import Link from "next/link";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerMain}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.brand} aria-label="Zyon home">
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
              Zyon
            </Link>
            <p className={styles.footerTag}>
              AI infrastructure for businesses that run on WhatsApp.
            </p>
            {/* Placeholder social links — replace with real profiles before launch */}
            <div className={styles.socials}>
              <a href="#" className={styles.social} aria-label="Zyon on X">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a href="#" className={styles.social} aria-label="Zyon on LinkedIn">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" />
                  <rect x="2" y="9" width="4" height="12" />
                  <circle cx="4" cy="4" r="2" />
                </svg>
              </a>
            </div>
          </div>

          <div className={styles.footerCols}>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Product</div>
              <a href="#">AI WhatsApp Receptionist</a>
              <a href="#">Workflow Automation</a>
              <a href="#">AI Agents</a>
              <a href="#">CRM</a>
              <a href="#">Appointment Management</a>
              <a href="#">
                AI Voice Calling <span className={styles.soon}>Soon</span>
              </a>
            </div>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Solutions</div>
              <a href="#">Clinics &amp; Healthcare</a>
              <a href="#">Real Estate</a>
              <a href="#">Finance</a>
              <a href="#">All industries</a>
            </div>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Company</div>
              <a href="#">About</a>
              <a href="#">Contact</a>
              <a href="#">Pricing</a>
            </div>
            <div className={styles.fcol}>
              <div className={styles.fcolTitle}>Resources</div>
              <a href="#">Blog</a>
              <a href="#">Guides</a>
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
          {/* Replace "Zyon" with your registered legal entity name before Meta submission — it must match exactly */}
          <div className={styles.copy}>
            &copy; 2026 <span className={styles.copyEntity}>Zyon</span> &middot; India
          </div>
          <p className={styles.trademark}>
            Zyon is built on the WhatsApp Business Platform. WhatsApp is a
            trademark of Meta Platforms, Inc., used for identification only.
          </p>
        </div>
      </div>
    </footer>
  );
}
