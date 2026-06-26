import { type ReactNode } from "react";
import styles from "./Eyebrow.module.css";

interface EyebrowProps {
  children: ReactNode;
  variant?: "dot" | "bar";
  className?: string;
}

export function Eyebrow({ children, variant = "dot", className }: EyebrowProps) {
  return (
    <span className={`${styles.eyebrow}${className ? ` ${className}` : ""}`}>
      <span className={variant === "bar" ? styles.bar : styles.dot} />
      {children}
    </span>
  );
}
