import React from "react";
import ReactDOM from "react-dom/client";
import { Amplify } from "aws-amplify";
import App from "./App";
import { setApiUrl } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import type { AppConfig } from "./types";
import "./styles.css";

function isAppConfig(value: unknown): value is AppConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return ["apiUrl", "region", "userPoolId", "userPoolClientId"].every(
    (key) => typeof config[key] === "string" && config[key].length > 0
  );
}

function root() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Application root is unavailable");
  return ReactDOM.createRoot(element);
}

function BootstrapError() {
  return (
    <main className="recovery-screen" role="alert">
      <section className="recovery-card">
        <span className="recovery-mark" aria-hidden="true">!</span>
        <p className="eyebrow">STARTUP RECOVERY</p>
        <h1>The application could not start</h1>
        <p>Configuration is temporarily unavailable. Reload to try again.</p>
        <button className="primary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </section>
    </main>
  );
}

async function bootstrap(): Promise<void> {
  const res = await fetch("/config.json");
  if (!res.ok) throw new Error(`Configuration request failed (${res.status})`);
  const config: unknown = await res.json();
  if (!isAppConfig(config)) throw new Error("Configuration response is invalid");

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });
  setApiUrl(config.apiUrl);

  root().render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("UI bootstrap failure", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  root().render(<BootstrapError />);
});
