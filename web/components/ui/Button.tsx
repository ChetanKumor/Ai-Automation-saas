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
