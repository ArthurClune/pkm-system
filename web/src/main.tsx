// pattern: Imperative Shell
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { isPhoneUserAgent, phoneViewportContent } from "./outline/keyboardBar";
import "./styles.css";

// Offline shell (docs/architecture/frontend.md § Build notes): the service
// worker precaches the SPA and runtime-caches viewed /assets/; persistent
// storage keeps the replica's OPFS database (and the SW caches) off the
// browser's eviction list.
registerSW({ immediate: true });
if (navigator.storage?.persist) {
  void navigator.storage.persist();
}

if (isPhoneUserAgent(navigator.userAgent)) {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content = phoneViewportContent(viewport.content);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
