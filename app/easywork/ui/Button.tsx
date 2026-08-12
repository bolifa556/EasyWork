import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  compact?: boolean;
  iconOnly?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = "secondary",
  compact = false,
  iconOnly = false,
  icon,
  className = "",
  children,
  ...props
}: Props) {
  return (
    <button
      className={`${styles.button} ${styles[variant]} ${compact ? styles.compact : ""} ${iconOnly ? styles.iconOnly : ""} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}
