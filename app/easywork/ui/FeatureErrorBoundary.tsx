"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import styles from "./FeatureErrorBoundary.module.css";

type Props = { children: ReactNode; resetKey: string };
type State = { error: Error | null };

export class FeatureErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("EasyWork feature failed", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className={styles.state} role="alert">
        <CircleAlert size={27} />
        <h2>此页面没有正常打开</h2>
        <p>{this.state.error.message || "页面组件发生异常"}</p>
        <button onClick={() => this.setState({ error: null })}><RotateCcw size={15} />重新载入</button>
      </section>
    );
  }
}
