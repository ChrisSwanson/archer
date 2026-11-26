import { browserFetch } from "./browser-resource";
import { runtime } from "./runtime.ts";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { currentNetworkAccess, subscribeNetworkAccess, type NetworkAccessState } from "./network-access";
import { setCharacterShortcutsEnabled, useCharacterShortcuts } from "./shortcuts";
import { setCurvedLinesEnabled, useCurvedLines } from "./curved-lines";
import "./ArcherSettings.css";
import dialogStyles from "./ArcherSettingsDialog.css?inline";
import { useOnDemandStyles } from "../theme/on-demand-styles";

type CommentSubmission = "queued" | "immediate";
type SettingValue = string | number | boolean | null;

/** The service settings the page can name; anything else a service sends is not shown. */
const SETTING_LABELS = {
  edit: "Editing in the page",
  host: "Listen address",
  port: "Port",
  publicUrl: "Public address",
  admission: "Project admission",
  openBrowser: "Open a browser",
  autoStart: "Start on demand",
  restore: "Restore after restart",
  commentSubmission: "Comment submission",
  pairingCodeMinutes: "Pairing code minutes",
  tlsCert: "TLS certificate",
  tlsKey: "TLS key",
  forceHttp: "Plain HTTP",
} as const;
type SettingKey = keyof typeof SETTING_LABELS;
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  builtin: "Default",
  user: "Set in your archer.toml",
  system: "Set in the system archer.toml",
  env: "Set by an environment variable",
  flag: "Set on the command line",
};

export type SettingRow = {
  readonly key: SettingKey;
  readonly value: SettingValue;
  readonly default: SettingValue;
  readonly source: string;
};

export type Settings = {
  readonly serviceName: string;
  readonly commentSubmission: CommentSubmission;
  readonly configRevision: string;
  readonly configPath: string;
  readonly settings: readonly SettingRow[];
};

export type ArcherSettingsProps = {
  /** Whether the service has said it offers the settings (`instanceSettings`); until then there is no control. */
  readonly supported?: boolean;
};

class SettingsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsResponseError";
  }
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

const scalar = (value: unknown): value is SettingValue =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 2048);

function rows(value: unknown): SettingRow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((row): SettingRow[] => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    if (
      typeof r.key !== "string" ||
      !Object.hasOwn(SETTING_LABELS, r.key) ||
      !scalar(r.value) ||
      !scalar(r.default) ||
      typeof r.source !== "string" ||
      r.source.length > 32
    )
      return [];
    return [{ key: r.key as SettingKey, value: r.value, default: r.default, source: r.source }];
  });
}

export function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettingsResponseError("The service returned settings in an unreadable format.");
  }
  const record = value as Record<string, unknown>;
  if (
    !boundedString(record.serviceName, 256) ||
    (record.commentSubmission !== "queued" && record.commentSubmission !== "immediate") ||
    !boundedString(record.configRevision, 512) ||
    !boundedString(record.configPath, 4096)
  ) {
    throw new SettingsResponseError("The service returned settings in an unreadable format.");
  }
  return {
    serviceName: record.serviceName,
    commentSubmission: record.commentSubmission,
    configRevision: record.configRevision,
    configPath: record.configPath,
    settings: rows(record.settings),
  };
}

async function readResponse(response: Response): Promise<Settings> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SettingsResponseError("The service returned settings in an unreadable format.");
  }
  if (!response.ok) throw new SettingsResponseError("Settings could not be loaded. Try again.");
  return parseSettings(body);
}

function errorMessage(error: unknown): string {
  if (error instanceof SettingsResponseError) return error.message;
  return "Settings could not be loaded. Try again.";
}

function shown(key: SettingKey, value: SettingValue): string {
  if (key === "commentSubmission") return value === "immediate" ? "Send each comment" : "Queue comments";
  if (key === "tlsKey" && value !== null) return "Set (hidden)";
  if (value === null) return key === "port" ? "Chosen when the service starts" : "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  return String(value);
}

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * Whether Archer is open to the person's network: where, since when, and how to turn it off (ticket 11, ADR 0017).
 * It is a fact about the service the page reads from its connection; the page never switches it (ADR 0028).
 */
function NetworkStatus({
  example,
}: {
  readonly example?: { readonly networkAccess: NetworkAccessState };
}): JSX.Element {
  // An external store read through React's own hook: a change between this section's mount and its
  // subscription is not missed, as it could be by a passive-effect subscription on a loaded machine.
  const observed: NetworkAccessState = useSyncExternalStore(subscribeNetworkAccess, currentNetworkAccess);
  // With no service to answer, the runtime's example stands in for it.
  const access = example ? example.networkAccess : observed;
  const heading = useId();
  return (
    <section className="archer-settings-network" aria-labelledby={heading}>
      <h3 id={heading}>Network Access</h3>
      {access === undefined ? (
        <p>Not known yet: the service has not said.</p>
      ) : access === null ? (
        <p>Not open to your network: only this computer can open Archer.</p>
      ) : (
        <p>
          Open to your network at <strong>{access.address.slice(access.address.indexOf("//") + 2, -1)}</strong> since{" "}
          {new Date(access.since).toLocaleString()}. To turn it off, ask your agent, or run{" "}
          <code>archer network-access off</code>. This page never changes it.
        </p>
      )}
    </section>
  );
}

// Its teeth reach the box's edge, so it is drawn at 80% on the icon scale's padded box (`--icon`).
export function SettingsGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g transform="translate(12 12.5) scale(0.8) translate(-12 -13)">
        <path d="M9.6 3.2h4.8l.7 2.4 2.2 1.3 2.4-.6 2.4 4.1-1.7 1.8v2.6l1.7 1.8-2.4 4.1-2.4-.6-2.2 1.3-.7 2.4H9.6l-.7-2.4-2.2-1.3-2.4.6-2.4-4.1 1.7-1.8v-2.6l-1.7-1.8 2.4-4.1 2.4.6 2.2-1.3.7-2.4Z" />
        <circle cx="12" cy="13" r="3" />
      </g>
    </svg>
  );
}

export default function ArcherSettings(props: ArcherSettingsProps): JSX.Element | null {
  const characterKeys = useCharacterShortcuts();
  const curvedLines = useCurvedLines();
  const supported = props.supported ?? true;
  const [open, setOpen] = useState(false);
  useOnDemandStyles("archer-settings-dialog", dialogStyles, open);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [portal] = useState(() => document.createElement("div"));
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setSettings(null);
    setError(null);
    void browserFetch("api/settings", { cache: "no-store", signal: controller.signal })
      .then(readResponse)
      .then(setSettings)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, reload]);

  useLayoutEffect(() => {
    if (!open) return;
    portal.className = "archer-settings-portal";
    document.body.append(portal);
    const backgrounds = [...document.body.children]
      .filter((element) => element !== portal)
      .map((element) => ({ element, inert: element.getAttribute("inert") }));
    for (const { element } of backgrounds) element.setAttribute("inert", "");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    return () => {
      for (const { element, inert } of backgrounds) {
        if (inert === null) element.removeAttribute("inert");
        else element.setAttribute("inert", inert);
      }
      document.body.style.overflow = overflow;
      portal.remove();
      launcher.current?.focus();
    };
  }, [open, portal]);

  if (!supported) return null;

  const close = (): void => setOpen(false);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!controls || controls.length === 0) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  const onScrimClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) close();
  };

  const layer = open
    ? createPortal(
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on a click on itself only; the keyboard closes the dialog with Escape, handled inside it.
        <div className="archer-settings-scrim" onMouseDown={onScrimClick}>
          <div
            ref={dialog}
            className="archer-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            <header className="archer-settings-heading">
              <div>
                <h2 id={titleId}>Archer Settings</h2>
              </div>
              <button type="button" className="archer-settings-close" aria-label="Close settings" onClick={close}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M5 5l10 10M15 5 5 15" />
                </svg>
              </button>
            </header>
            <div className="archer-settings-content">
              {runtime.examples === undefined ? null : (
                <p className="archer-settings-example">{runtime.examples.settingsNote}</p>
              )}
              <section className="archer-settings-network" aria-label="Keyboard">
                <h3>Keyboard</h3>
                <label className="archer-settings-toggle">
                  <input
                    type="checkbox"
                    checked={characterKeys}
                    onChange={(event) => setCharacterShortcutsEnabled(event.target.checked)}
                  />{" "}
                  Single-character shortcuts
                </label>
                <p>
                  Use letters, numbers and punctuation for Help, search and diagram actions. Turn off to disable them
                  everywhere in Archer. Saved in this browser; Escape and modified keys still work.
                </p>
              </section>
              <section className="archer-settings-network" aria-label="Diagrams">
                <h3>Diagrams</h3>
                <label className="archer-settings-toggle">
                  <input
                    type="checkbox"
                    checked={curvedLines}
                    onChange={(event) => setCurvedLinesEnabled(event.target.checked)}
                  />{" "}
                  Curved lines
                </label>
                <p>
                  Draw connections with wide curves instead of square corners. Lines keep their routes and crossings.
                  Saved in this browser.
                </p>
              </section>
              {loading ? (
                <p className="archer-settings-status" role="status">
                  Loading settings…
                </p>
              ) : null}
              <NetworkStatus example={runtime.examples} />
              {!loading && settings ? (
                <>
                  <dl className="archer-settings-identity">
                    <div>
                      <dt>Service</dt>
                      <dd>{settings.serviceName}</dd>
                    </div>
                    <div>
                      <dt>Configuration file</dt>
                      <dd>
                        <code>{settings.configPath}</code>
                      </dd>
                    </div>
                  </dl>
                  {settings.settings.length > 0 ? (
                    <ul className="archer-settings-list" aria-label="Service settings" aria-disabled="true">
                      {settings.settings.map((row) => (
                        <li key={row.key} aria-label={SETTING_LABELS[row.key]}>
                          <span className="archer-settings-name">{SETTING_LABELS[row.key]}</span>
                          <span className="archer-settings-value">{shown(row.key, row.value)}</span>
                          <small>
                            {row.source === "builtin" ? (
                              "Default"
                            ) : (
                              <>
                                {SOURCE_LABELS[row.source] ?? "Set"} · Default: {shown(row.key, row.default)}
                              </>
                            )}
                          </small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <dl className="archer-settings-identity">
                      <div>
                        <dt>Comment submission</dt>
                        <dd>{shown("commentSubmission", settings.commentSubmission)}</dd>
                      </div>
                    </dl>
                  )}
                  <p className="archer-settings-hint">
                    These settings are read-only here. Change them in the configuration file above or the environment,
                    then restart the service.
                  </p>
                </>
              ) : null}
              {!loading && !settings && !error ? (
                <p className="archer-settings-status">Settings are unavailable.</p>
              ) : null}
              {error ? (
                <div className="archer-settings-error" role="alert">
                  <span>{error}</span>
                  {!settings ? (
                    <button type="button" onClick={() => setReload((value) => value + 1)}>
                      Try again
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>,
        portal,
      )
    : null;

  return (
    <>
      <button
        ref={launcher}
        type="button"
        className="archer-settings-launcher"
        aria-label="Archer settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Archer settings"
        onClick={() => setOpen(true)}
      >
        <SettingsGlyph />
        <span>Settings</span>
      </button>
      {layer}
    </>
  );
}
