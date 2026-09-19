import type { ReactNode } from "react";
import styles from "./PageFrame.module.css";

export function PageFrame({ icon, title, count, actions, children }: { icon: ReactNode; title: string; count?: number; actions?: ReactNode; children: ReactNode }) {
  return <div className={`${styles.page} ew-page-scrollbar`}><div className={styles.inner}><header className={styles.header}><span data-ui-icon="" className={styles.icon}>{icon}</span><h1 className={styles.title}>{title}</h1>{count !== undefined ? <span className={styles.count}>{count}</span> : null}<span className={styles.spacer} />{actions}</header>{children}</div></div>;
}

export const pageFrameStyles = styles;
