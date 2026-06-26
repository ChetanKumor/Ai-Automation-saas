"use client";

import { type ReactNode } from "react";
import { useScrollReveal } from "@/lib/useScrollReveal";

interface RevealProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Reveal({ children, className, style }: RevealProps) {
  const ref = useScrollReveal<HTMLDivElement>();

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
