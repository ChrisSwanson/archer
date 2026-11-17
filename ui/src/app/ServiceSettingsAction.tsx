import { useEffect, useState, type JSX } from "react";
import ArcherSettings, { SettingsGlyph } from "./ArcherSettings";
import { discoverServiceSettings, type ServiceSettingsDiscovery } from "./service-settings";
import { withReadDeadline } from "./read-deadline";
import { runtime } from "./runtime.ts";

/** Service discovery belongs to the workspace action, independently of a page's document permissions. */
export function ServiceSettingsAction(): JSX.Element | null {
  // A runtime with example settings has no service to discover: its settings are there to open.
  return runtime.examples === undefined ? <DiscoveredSettings /> : <ArcherSettings supported />;
}

function DiscoveredSettings(): JSX.Element {
  const [state, setState] = useState<ServiceSettingsDiscovery | { kind: "loading" }>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const lifetime = new AbortController();
    setState({ kind: "loading" });
    void withReadDeadline((signal) => {
      const combined = AbortSignal.any([signal, lifetime.signal]);
      return discoverServiceSettings(undefined, combined);
    }).then(
      (next) => {
        if (live) setState(next);
      },
      () => {
        if (live) setState({ kind: "unavailable" });
      },
    );
    return () => {
      live = false;
      lifetime.abort();
    };
  }, [attempt]);
  if (state.kind === "supported") return <ArcherSettings supported />;
  const message =
    state.kind === "loading"
      ? "Checking settings…"
      : state.kind === "incompatible"
        ? "Settings need a compatible server. Retry settings discovery."
        : state.kind === "access-required"
          ? "Settings access is unavailable. Open a new access link."
          : "Settings are unavailable. Retry settings discovery.";
  return (
    <button
      type="button"
      className="archer-settings-launcher"
      disabled={state.kind === "loading"}
      aria-label={state.kind === "loading" ? "Checking settings" : "Retry settings discovery"}
      title={message}
      onClick={() => setAttempt((value) => value + 1)}
    >
      <SettingsGlyph />
      <span>{state.kind === "loading" ? "Settings" : "Retry settings"}</span>
    </button>
  );
}
