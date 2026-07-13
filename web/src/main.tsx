// pattern: Imperative Shell
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ROUTER_FUTURE_FLAGS } from "./router";
import "./styles.css";

// Offline shell (spec section 5): the service worker precaches the SPA and
// runtime-caches viewed /assets/; persistent storage keeps the replica's
// OPFS database (and the SW caches) off the browser's eviction list.
registerSW({ immediate: true });
if (navigator.storage?.persist) {
  void navigator.storage.persist();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter future={ROUTER_FUTURE_FLAGS}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
