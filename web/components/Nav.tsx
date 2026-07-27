"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { waLink, waMessages } from "@/lib/siteConfig";
import styles from "./Nav.module.css";

const NAV_LINKS = [
  { label: "What it does", href: "#platform" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Escape closes the drawer. Bound only while it is open, so the listener does
  // not sit on the document for the whole session. If focus is inside the drawer
  // when it closes, return it to the toggle — otherwise dismissing with the
  // keyboard drops focus onto <body> and the next Tab restarts from the top.
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focusWasInside = mobileMenuRef.current?.contains(
        document.activeElement
      );
      setMenuOpen(false);
      if (focusWasInside) menuBtnRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <nav className={`${styles.nav}${scrolled ? ` ${styles.scrolled}` : ""}`}>
      <div className={styles.navInner}>
        <Link href="/" className={styles.brand} aria-label="Prantivo home">
          <svg className={styles.mark} viewBox="0 0 22 22" aria-hidden="true">
            <rect x="2" y="2" width="18" height="18" rx="5" />
            <circle cx="7.5" cy="11" r="1.5" />
            <circle cx="11" cy="11" r="1.5" />
            <circle cx="14.5" cy="11" r="1.5" />
          </svg>
          Prantivo
        </Link>

        <div className={styles.navLinks}>
          {NAV_LINKS.map((link) => (
            <a key={link.label} href={link.href}>
              {link.label}
            </a>
          ))}
        </div>

        <div className={styles.navCta}>
          <Button
            variant="primary"
            href={waLink(waMessages.demo)}
            aria-label="Book a demo on WhatsApp"
          >
            Book a demo
          </Button>
          <button
            ref={menuBtnRef}
            className={styles.menuBtn}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <line x1="3" y1="7" x2="21" y2="7" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="17" x2="21" y2="17" />
            </svg>
          </button>
        </div>
      </div>

      <div
        id="mobile-menu"
        ref={mobileMenuRef}
        className={`${styles.mobileMenu}${menuOpen ? ` ${styles.open}` : ""}`}
      >
        {NAV_LINKS.map((link) => (
          // Every link is an in-page anchor, so navigating does not unmount the
          // nav and nothing else clears menuOpen. Without this the drawer — a
          // full-width panel at 0.95 alpha with a 14px blur — stays open on top
          // of the section the tap just scrolled to.
          <a
            key={link.label}
            href={link.href}
            onClick={() => setMenuOpen(false)}
          >
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
