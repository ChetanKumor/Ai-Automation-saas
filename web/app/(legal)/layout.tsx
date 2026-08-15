import Link from "next/link";
import styles from "./legal.module.css";

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The Warm Paper ground for this route group, applied HERE rather than on
    // `body`. `body` is shared with the marketing group, which is still dark;
    // moving it would repaint the whole site in a session whose control arm is
    // marketing at zero differing pixels.
    //
    // min-height:100vh keeps body's --ink-900 from showing below the footer on
    // a page shorter than the viewport. It is DEFENSIVE, not currently
    // load-bearing, and the difference is worth stating: the shortest page in
    // this group is /data-deletion at 1866px CSS (1440 wide), so no viewport
    // any capture used comes close to exposing the gap. It guards a future
    // short page — an error state, a stub policy — rather than a present one.
    //
    // KNOWN RESIDUE, accepted: `body` still paints the overscroll rubber-band
    // area on iOS and macOS, so a paper page inside a dark body flashes
    // near-black when overscrolled. Fixing it means touching body or html,
    // which is the one atomic change this session exists to avoid. It goes away
    // at S2 when the ground flips site-wide.
    <div className={styles.paper}>
      <div className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/" className={styles.brand}>
            <svg className={styles.mark} viewBox="0 0 22 22" aria-hidden="true">
              <rect x="2" y="2" width="18" height="18" rx="5" />
              <circle cx="7.5" cy="11" r="1.5" />
              <circle cx="11" cy="11" r="1.5" />
              <circle cx="14.5" cy="11" r="1.5" />
            </svg>
            Prantivo
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
          <div className={styles.copy}>&copy; 2026 Prantivo &middot; India</div>
        </div>
      </footer>
    </div>
  );
}
