// pattern: Imperative Shell
// A React class component with its own lifecycle state (getDerivedStateFromError),
// not a pure rendering decision.
import { Component, type ReactNode } from "react";

interface State {
  failed: boolean;
  message: string;
}

/** Root render-error net (plan-4 carry-forward): editing state raises the
 * odds of a render throw; fail to a message + reload link, not a white
 * screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: String(error) };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="error-screen">
          <h1>Something went wrong</h1>
          <p className="error">{this.state.message}</p>
          <a href="/">Reload</a>
        </div>
      );
    }
    return this.props.children;
  }
}
