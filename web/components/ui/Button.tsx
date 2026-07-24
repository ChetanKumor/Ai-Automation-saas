import Link from "next/link";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "default" | "large";
  href?: string;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size,
  href,
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    styles.btn,
    styles[variant],
    size === "large" && styles.large,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (href) {
    // External links (wa.me, http/https) open in a new tab and skip next/link.
    if (/^https?:\/\//i.test(href)) {
      return (
        <a
          href={href}
          className={cls}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={rest["aria-label"]}
        >
          {children}
          {icon}
        </a>
      );
    }
    return (
      <Link href={href} className={cls}>
        {children}
        {icon}
      </Link>
    );
  }

  return (
    <button className={cls} {...rest}>
      {children}
      {icon}
    </button>
  );
}
