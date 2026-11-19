// pattern: Imperative Shell
// A React class component with its own lifecycle state
// (getDerivedStateFromError), not a pure rendering decision.
import { Component, type ReactNode } from "react";
import { cleanReload } from "../cleanReload";

interface State {
  failed: boolean;
  message: string;
}

/** Root render-error net: editing state raises the
 * odds of a render throw; fail to a message + reload button, not a white
 * screen. The reload is clean: a throw can come from a stale cached bundle
 * meeting a newer server, which a plain reload would boot again. */
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
          <button type="button" onClick={() => { void cleanReload(); }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
