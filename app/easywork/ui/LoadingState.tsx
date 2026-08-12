import styles from "./LoadingState.module.css";

export function LoadingState({ label = "正在载入 EasyWork" }: { label?: string }) {
  return <div className={styles.root} role="status"><span className={styles.spinner} /><span>{label}</span></div>;
}
