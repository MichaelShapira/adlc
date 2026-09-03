import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean; correlationId: string };

function correlationId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `ui-${Date.now().toString(36)}`;
  } catch {
    return `ui-${Date.now().toString(36)}`;
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, correlationId: "" };

  static getDerivedStateFromError(): State {
    return { failed: true, correlationId: correlationId() };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo): void {
    console.error("UI render failure", {
      correlationId: this.state.correlationId,
      componentStack: info.componentStack ?? "Unavailable",
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="recovery-screen" role="alert">
        <section className="recovery-card">
          <span className="recovery-mark" aria-hidden="true">!</span>
          <p className="eyebrow">VIEW RECOVERY</p>
          <h1>This view could not be displayed</h1>
          <p>
            The application protected the rest of the session from unexpected data.
            Reload to request a fresh copy.
          </p>
          <p className="muted small">
            Correlation ID: <code>{this.state.correlationId}</code>
          </p>
          <button className="primary" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </section>
      </main>
    );
  }
}
