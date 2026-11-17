import { browserFetch } from "./browser-resource";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  announceProjectCatalogChanged,
  isInactiveProject,
  mutateProjectLifecycle,
  parseProjectLifecycle,
  type ProjectLifecycle,
  type ProjectLifecycleAction,
  type ProjectVisibility,
} from "./project-lifecycle";
import { updateRememberedProjectLifecycle } from "./project-directory";
import projectSettingsStyles from "./ProjectSettings.css?inline";
import { useOnDemandStyles } from "../theme/on-demand-styles";
import { CloseGlyph } from "../diagrams/ControlGlyphs";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `GET/PATCH <project resource base>api/project-settings` (ts/src/config/project-settings.ts). */
export type ProjectSettingsSnapshot = {
  readonly slug: string;
  readonly revision: string | null;
  readonly loaded: boolean;
  readonly general: {
    readonly name: string;
    readonly nameSource: "archer.toml" | "directory";
    readonly description: string | null;
    readonly location: string;
    readonly folder: string;
    readonly editing: { readonly enabled: boolean; readonly source: "project" | "account" | "default" };
  };
  readonly views: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly source: string;
  }[];
  readonly viewProblems: readonly { readonly id: string | null; readonly message: string }[];
  readonly discovery: {
    readonly roots: readonly string[];
    readonly exclude: readonly string[];
    readonly rootsConfigured: boolean;
    readonly excludeConfigured: boolean;
  };
  readonly feedback: {
    readonly changes: string;
    readonly delivery: string;
    readonly allowNotifications: boolean;
    readonly sources: { readonly changes: string; readonly delivery: string; readonly allowNotifications: string };
  } | null;
  readonly visibility: ProjectLifecycle;
  readonly manifest: { readonly path: string; readonly text: string } | null;
};

export type ProjectSettingsDialogProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The project's resource base (`projectResourceBase`), e.g. `http://host/p/<slug>/`. */
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly projectName: string;
  /** Every diagram file, from the page's inventory; omitted rather than guessed. */
  readonly diagramCount?: number;
  readonly noteCount?: number;
  /** Where the Notes section links: the project's file list. */
  readonly notesHref?: string;
  /** Where focus returns on close; else whatever held focus when the dialog opened. */
  readonly opener?: RefObject<HTMLElement | null>;
  /** After a save, with the service's new snapshot (the page title can follow the name). */
  readonly onSaved?: (snapshot: ProjectSettingsSnapshot) => void;
};

class UnreadableSettings extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseProjectSettings(value: unknown): ProjectSettingsSnapshot {
  const fail = (): never => {
    throw new UnreadableSettings("The service returned project settings in an unreadable format.");
  };
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.slug !== "string") return fail();
  const general = value.general,
    discovery = value.discovery,
    feedback = value.feedback,
    manifest = value.manifest;
  if (
    !isRecord(general) ||
    typeof general.name !== "string" ||
    typeof general.location !== "string" ||
    typeof general.folder !== "string" ||
    (general.description !== null && typeof general.description !== "string")
  )
    return fail();
  const editing = general.editing;
  if (
    !isRecord(editing) ||
    typeof editing.enabled !== "boolean" ||
    (editing.source !== "project" && editing.source !== "account" && editing.source !== "default")
  )
    return fail();
  if (value.revision !== null && typeof value.revision !== "string") return fail();
  if (!Array.isArray(value.views) || !Array.isArray(value.viewProblems)) return fail();
  if (!isRecord(discovery) || !strings(discovery.roots) || !strings(discovery.exclude)) return fail();
  const configured = isRecord(discovery.configured) ? discovery.configured : {};
  if (
    feedback !== null &&
    (!isRecord(feedback) ||
      typeof feedback.changes !== "string" ||
      typeof feedback.delivery !== "string" ||
      !isRecord(feedback.sources))
  )
    return fail();
  if (manifest !== null && (!isRecord(manifest) || typeof manifest.text !== "string")) return fail();
  const visibility = parseProjectLifecycle(value.visibility);
  if (visibility === null || value.visibility === undefined) return fail();
  const views = (value.views as unknown[]).filter(isRecord).map((view) => ({
    id: String(view.id),
    kind: String(view.kind),
    title: typeof view.title === "string" ? view.title : String(view.id),
    source: String(view.source),
  }));
  const viewProblems = (value.viewProblems as unknown[]).filter(isRecord).map((problem) => ({
    id: typeof problem.id === "string" ? problem.id : null,
    message: String(problem.message),
  }));
  const sources = isRecord(feedback) && isRecord(feedback.sources) ? feedback.sources : {};
  return {
    slug: value.slug,
    revision: value.revision,
    loaded: value.loaded === true,
    general: {
      name: general.name,
      nameSource: general.nameSource === "archer.toml" ? "archer.toml" : "directory",
      description: general.description,
      location: general.location,
      folder: general.folder,
      editing: { enabled: editing.enabled, source: editing.source },
    },
    views,
    viewProblems,
    discovery: {
      roots: discovery.roots,
      exclude: discovery.exclude,
      rootsConfigured: configured.roots !== undefined,
      excludeConfigured: configured.exclude !== undefined,
    },
    feedback: isRecord(feedback)
      ? {
          changes: String(feedback.changes),
          delivery: String(feedback.delivery),
          allowNotifications: feedback.allowNotifications === true,
          sources: {
            changes: String(sources.changes),
            delivery: String(sources.delivery),
            allowNotifications: String(sources.allowNotifications),
          },
        }
      : null,
    visibility,
    manifest: isRecord(manifest)
      ? { path: typeof manifest.path === "string" ? manifest.path : "archer.toml", text: manifest.text as string }
      : null,
  };
}

/** `{error:{code,message}}` from a refused request, when the body says so. */
async function refusal(response: Response): Promise<{ code: string; message: string } | null> {
  try {
    const body: unknown = await response.json();
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.code === "string" &&
      typeof body.error.message === "string"
    )
      return { code: body.error.code, message: body.error.message };
  } catch {
    /* not JSON */
  }
  return null;
}

const VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  auto: "Automatic",
  visible: "Always show",
  hidden: "Archive",
};
const VISIBILITY_ACTION: Record<ProjectVisibility, ProjectLifecycleAction> = {
  auto: "auto",
  visible: "show",
  hidden: "archive",
};
const SOURCE_LABEL: Record<string, string> = {
  project: "archer.toml",
  builtin: "default",
  user: "your settings",
  system: "system settings",
};
const VALUE_LABEL: Record<string, string> = {
  on_save: "On save",
  manual: "Manual",
  next_call: "Next call",
  next_call_and_notify: "Next call and notify",
};
const SECTIONS = ["General", "Diagrams", "Notes", "Discovery", "Feedback", "Visibility", "archer.toml"] as const;
type Section = (typeof SECTIONS)[number];

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** `/home/<user>/…` and `/Users/<user>/…` read as `~/…`. */
const homeRelative = (path: string): string => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/u, "~");

export function inactiveReason(lifecycle: ProjectLifecycle): string {
  if (lifecycle.visibility === "hidden" || lifecycle.reason === "manual")
    return "Archived. Choose Automatic or Always show to list it on the Projects page again.";
  return "No notes or diagrams yet. Add one and this project becomes Active again, or choose Always show to keep it listed.";
}

type Draft = { readonly name?: string; readonly description?: string; readonly visibility?: ProjectVisibility };
type Change = {
  readonly key: "name" | "description" | "visibility";
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly destination: string;
};
type Phase = "loading" | "ready" | "failed";

function pendingChanges(snapshot: ProjectSettingsSnapshot | null, draft: Draft): Change[] {
  if (snapshot === null) return [];
  const changes: Change[] = [];
  if (draft.name !== undefined && draft.name.trim() !== snapshot.general.name)
    changes.push({
      key: "name",
      label: "Name",
      from: snapshot.general.name,
      to: draft.name.trim(),
      destination: "archer.toml",
    });
  const description = snapshot.general.description ?? "";
  if (draft.description !== undefined && draft.description.trim() !== description)
    changes.push({
      key: "description",
      label: "Description",
      from: description,
      to: draft.description.trim(),
      destination: "archer.toml",
    });
  if (draft.visibility !== undefined && draft.visibility !== snapshot.visibility.visibility)
    changes.push({
      key: "visibility",
      label: "Visibility",
      from: VISIBILITY_LABEL[snapshot.visibility.visibility],
      to: VISIBILITY_LABEL[draft.visibility],
      destination: "service setting",
    });
  return changes;
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

function LockIcon(): JSX.Element {
  return (
    <svg
      className="archer-project-settings-lock"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      role="img"
      aria-label="Protected"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** A small button that shows its tooltip while hovered or focused. */
function Tip(props: {
  readonly className: string;
  readonly label: string;
  readonly children: ReactNode;
  readonly tip: ReactNode;
}): JSX.Element {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <span className="archer-project-settings-tip-anchor">
      <button
        type="button"
        className={props.className}
        aria-label={props.label}
        aria-describedby={shown ? id : undefined}
        onMouseEnter={() => setShown(true)}
        onMouseLeave={() => setShown(false)}
        onFocus={() => setShown(true)}
        onBlur={() => setShown(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && shown) {
            event.stopPropagation();
            setShown(false);
          }
        }}
      >
        {props.children}
      </button>
      {shown ? (
        <span id={id} role="tooltip" className="archer-project-settings-tooltip">
          {props.tip}
        </span>
      ) : null}
    </span>
  );
}

function ChangeDot(props: { readonly change: Change | undefined }): JSX.Element | null {
  const change = props.change;
  if (change === undefined) return null;
  const shown = (text: string): string => (text === "" ? "(empty)" : text);
  return (
    <span className="archer-project-settings-gutter">
      <Tip
        className="archer-project-settings-dot"
        label={`${change.label} changed from ${shown(change.from)} to ${shown(change.to)}, saved to ${change.destination}`}
        tip={
          <>
            <span className="archer-project-settings-old">{shown(change.from)}</span>
            <span aria-hidden="true" className="archer-project-settings-arrow">
              →
            </span>
            <span className="archer-project-settings-new">{shown(change.to)}</span>
            <span className="archer-project-settings-destination">
              {change.destination === "archer.toml" ? "archer.toml" : "Service setting"}
            </span>
          </>
        }
      >
        <span aria-hidden="true" />
      </Tip>
    </span>
  );
}

export function ProjectSettingsDialog(props: ProjectSettingsDialogProps): JSX.Element | null {
  const { open, baseUrl } = props;
  // The dialog's rules join the page when it first opens: no page shows it on first load (S2).
  useOnDemandStyles("project-settings", projectSettingsStyles, open);
  const fetchImpl: FetchLike = props.fetchImpl ?? ((url, init) => browserFetch(url, init));
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const openerRef = useRef(props.opener);
  openerRef.current = props.opener;
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<ProjectSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<{ readonly message: string; readonly conflict: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reload, setReload] = useState(0);
  const [current, setCurrent] = useState<Section>("General");
  const [portal] = useState(() => document.createElement("div"));
  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  /** Set when the discard question is put away: Close settings takes focus once the footer is back. */
  const returnToClose = useRef(false);
  /** The section a nav jump went to; it keeps the marker until the reader scrolls on their own. */
  const jumped = useRef<Section | null>(null);
  const titleId = useId();
  const sectionId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const settingsUrl = new URL("api/project-settings", baseUrl).href;

  useEffect(() => {
    if (!open) return;
    setDraft({});
    setError(null);
    setConfirming(false);
    setCurrent("General");
    setSnapshot(null);
    setPhase("loading");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchRef.current(settingsUrl, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok)
          throw new Error((await refusal(response))?.message ?? "Project settings could not be loaded. Try again.");
        const next = parseProjectSettings(await response.json());
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setError(null);
        setPhase("ready");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError({
          message:
            caught instanceof Error && caught.message !== ""
              ? caught.message
              : "Project settings could not be loaded. Try again.",
          conflict: false,
        });
        setPhase((phase) => (phase === "ready" ? phase : "failed"));
      }
    })();
    return () => controller.abort();
  }, [open, reload, settingsUrl]);

  useLayoutEffect(() => {
    if (!open) return;
    const focused =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    portal.className = "archer-project-settings-portal";
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
      const target = openerRef.current?.current ?? focused;
      if (target?.isConnected) target.focus();
    };
  }, [open, portal]);

  useEffect(() => {
    if (confirming) keepEditing.current?.focus();
    else if (returnToClose.current) {
      returnToClose.current = false;
      closeButton.current?.focus();
    }
  }, [confirming]);

  if (!open) return null;

  const changes = pendingChanges(snapshot, draft);
  const change = (key: Change["key"]): Change | undefined => changes.find((candidate) => candidate.key === key);
  const nameEmpty = draft.name !== undefined && draft.name.trim() === "";
  const conflict = error?.conflict === true;
  const canSave = phase === "ready" && snapshot !== null && changes.length > 0 && !saving && !conflict && !nameEmpty;

  const close = (): void => {
    setConfirming(false);
    props.onClose();
  };
  /** Keep editing (or Escape at the question): back to the form, focus on Close settings, where the request began. */
  const keepEditingNow = (): void => {
    returnToClose.current = true;
    setConfirming(false);
  };
  const requestClose = (): void => {
    if (saving) return;
    if (changes.length > 0) setConfirming(true);
    else close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys belong to this modal rather than page-level bindings behind it.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (confirming) keepEditingNow();
      else requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!controls || controls.length === 0) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = controls[0]!,
      last = controls[controls.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === dialog.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = async (): Promise<void> => {
    if (!canSave || snapshot === null) return;
    setSaving(true);
    setError(null);
    let latest = snapshot;
    try {
      const visibility =
        changes.find((pending) => pending.key === "visibility") === undefined ? undefined : draft.visibility;
      if (visibility !== undefined) {
        const result = await mutateProjectLifecycle(fetchImpl, baseUrl, latest.slug, VISIBILITY_ACTION[visibility]);
        if (!result.ok) {
          setError({
            message: result.uncertain
              ? "The visibility change may not have been applied. Reload to check, then try again."
              : "Visibility could not be changed. Try again.",
            conflict: false,
          });
          return;
        }
        // The page's catalog (held per fetcher) takes the acknowledged lifecycle before anyone hears of it: a fresh
        // or racing catalog read can no longer show the former one, and the confirming read starts anew.
        updateRememberedProjectLifecycle(fetchImpl, latest.slug, result.lifecycle);
        announceProjectCatalogChanged();
        const response = await fetchImpl(settingsUrl, { cache: "no-store", credentials: "same-origin" });
        if (response.ok) latest = parseProjectSettings(await response.json());
        else latest = { ...latest, visibility: result.lifecycle };
        setSnapshot(latest);
      }
      setDraft({});
      props.onSaved?.(latest);
      close();
    } catch {
      setError({ message: "Project settings could not be saved. Try again.", conflict: false });
    } finally {
      setSaving(false);
    }
  };

  // A nav jump moves focus to the section's heading, so the next Tab is inside it, and that section keeps the
  // marker: the smooth scroll passing other headings, or a last section that cannot reach the top, does not move it.
  const goTo = (section: Section): void => {
    setCurrent(section);
    jumped.current = section;
    const target = document.getElementById(`${sectionId}-${SECTIONS.indexOf(section)}`);
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
  };
  /** The jump's scroll ending, or the reader's own (wheel, touch, a press, keys in the content), hands the marker back to the scroll position. */
  const ownScroll = (): void => {
    jumped.current = null;
  };
  const onScroll = (): void => {
    const box = content.current;
    if (box === null || jumped.current !== null) return;
    let found: Section = "General";
    SECTIONS.forEach((section, index) => {
      const element = document.getElementById(`${sectionId}-${index}`);
      if (element !== null && element.offsetTop - 32 <= box.scrollTop) found = section;
    });
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) found = SECTIONS[SECTIONS.length - 1]!;
    setCurrent(found);
  };

  const count = (section: Section): number | undefined =>
    section === "Diagrams" ? props.diagramCount : section === "Notes" ? props.noteCount : undefined;
  const heading = (section: Section, extra?: ReactNode): JSX.Element => (
    <h3
      id={`${sectionId}-${SECTIONS.indexOf(section)}`}
      className="archer-project-settings-section-title"
      tabIndex={-1}
    >
      {section}
      {extra}
    </h3>
  );

  const body = (s: ProjectSettingsSnapshot): JSX.Element => {
    // The page never writes archer.toml (ADR 0028): the person or an agent edits the file.
    const nameEditable = false;
    const descriptionEditable = false;
    const visibility = draft.visibility ?? s.visibility.visibility;
    const inactive = isInactiveProject(s.visibility);
    // Archiving or showing follows the edit switch (decision D1): the service refuses it where editing is off.
    const visibilityLocked = !s.general.editing.enabled;
    const status = inactive ? "Inactive" : s.visibility.state === "unknown" ? "Unknown" : "Active";
    const noManifestHint =
      s.manifest === null ? "This project has no archer.toml; add one to set a name and description." : null;
    return (
      <>
        {!s.loaded ? (
          <p className="archer-project-settings-notice" role="status">
            archer.toml changed since the service last loaded it; the values shown may be out of date.
          </p>
        ) : null}
        <section aria-labelledby={`${sectionId}-0`} className="archer-project-settings-section">
          {heading("General")}
          <div className="archer-project-settings-field">
            <div className="archer-project-settings-label">
              <ChangeDot change={change("name")} />
              <label htmlFor={nameId}>Name</label>
              {nameEditable ? null : <LockIcon />}
            </div>
            <input
              id={nameId}
              type="text"
              maxLength={200}
              readOnly={!nameEditable}
              aria-invalid={nameEmpty || undefined}
              value={draft.name ?? s.general.name}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            />
            {nameEmpty ? <span className="archer-project-settings-invalid">A name can't be empty.</span> : null}
            <span className="archer-project-settings-hint">
              {noManifestHint ?? (
                <>
                  Shown in the sidebar and page title. To change it, edit archer.toml's <code>name</code>.
                </>
              )}
            </span>
          </div>
          <div className="archer-project-settings-field">
            <div className="archer-project-settings-label">
              <ChangeDot change={change("description")} />
              <label htmlFor={descriptionId}>Description</label>
              {descriptionEditable ? null : <LockIcon />}
            </div>
            <textarea
              id={descriptionId}
              rows={2}
              maxLength={500}
              readOnly={!descriptionEditable}
              value={draft.description ?? s.general.description ?? ""}
              onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))}
            />
            <span className="archer-project-settings-hint">
              {noManifestHint ?? (
                <>
                  To change it, edit archer.toml's <code>description</code>. When empty, the page uses the README’s
                  first paragraph.
                </>
              )}
            </span>
          </div>
          <hr />
          <dl className="archer-project-settings-facts">
            <dt>Address</dt>
            <dd>
              <code>/projects/{s.slug}/</code>
              <span className="archer-project-settings-hint">
                Assigned by the service; stays fixed if the name changes.
              </span>
            </dd>
            <dt>
              Archer folder <LockIcon />
            </dt>
            <dd>
              <code>{s.general.folder}</code>
              <span className="archer-project-settings-hint">
                Changing it moves every diagram and note, so it is edited in archer.toml.
              </span>
            </dd>
            <dt>Location</dt>
            <dd>
              <code>{homeRelative(s.general.location)}</code>
            </dd>
            <>
              <dt>
                Editing in the page <LockIcon />
              </dt>
              <dd>
                {s.general.editing.enabled ? "On" : "Off"}
                <span className="archer-project-settings-hint">
                  {s.general.editing.source === "project" ? (
                    <>
                      Set by <code>edit</code> in this project's archer.toml.
                    </>
                  ) : s.general.editing.source === "account" ? (
                    <>
                      Set by <code>edit</code> in your account's archer.toml; <code>edit</code> in this project's
                      archer.toml overrides it.
                    </>
                  ) : (
                    <>
                      On by default. <code>edit = false</code> in archer.toml makes the page read &amp; comment.
                    </>
                  )}{" "}
                  Your agent can always change diagrams.
                </span>
              </dd>
            </>
          </dl>
        </section>

        <section aria-labelledby={`${sectionId}-1`} className="archer-project-settings-section">
          {heading("Diagrams")}
          {props.diagramCount === undefined ? null : <p>{plural(props.diagramCount, "diagram")} in this project.</p>}
          <div className="archer-project-settings-label archer-project-settings-sublabel">
            Registered views <LockIcon />
          </div>
          {s.views.length === 0 ? (
            <p className="archer-project-settings-hint">No views are registered in archer.toml.</p>
          ) : (
            <ul className="archer-project-settings-list">
              {s.views.map((view) => (
                <li key={view.id}>
                  <span>{view.title}</span>
                  <span className="archer-project-settings-meta">
                    {view.kind} · <code>{view.source}</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.viewProblems.length > 0 ? (
            <ul className="archer-project-settings-problems">
              {s.viewProblems.map((problem, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list re-rendered as a whole; its items hold no state.
                  key={index}
                >
                  {problem.id === null ? null : <code>{problem.id}</code>} {problem.message}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="archer-project-settings-hint">
            Registered in <code>[[views]]</code>; change them in archer.toml.
          </p>
        </section>

        <section aria-labelledby={`${sectionId}-2`} className="archer-project-settings-section">
          {heading("Notes")}
          <p>
            {props.noteCount === undefined ? "Notes" : plural(props.noteCount, "note")} have no settings yet.{" "}
            {props.notesHref === undefined ? null : <a href={props.notesHref}>Browse them in the file list</a>}
          </p>
        </section>

        <section aria-labelledby={`${sectionId}-3`} className="archer-project-settings-section">
          {heading("Discovery", <LockIcon />)}
          <dl className="archer-project-settings-facts">
            <dt>Roots</dt>
            <dd>
              <ul className="archer-project-settings-paths">
                {s.discovery.roots.map((root) => (
                  <li key={root}>
                    <code>{root}</code>
                  </li>
                ))}
              </ul>
              {s.discovery.rootsConfigured ? null : <span className="archer-project-settings-hint">Default</span>}
            </dd>
            <dt>Exclusions</dt>
            <dd>
              {s.discovery.exclude.length === 0 ? (
                <span className="archer-project-settings-hint">None</span>
              ) : (
                <ul className="archer-project-settings-paths">
                  {s.discovery.exclude.map((pattern) => (
                    <li key={pattern}>
                      <code>{pattern}</code>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
          <p className="archer-project-settings-hint">
            Change in archer.toml, under <code>[discovery]</code>.
          </p>
        </section>

        <section aria-labelledby={`${sectionId}-4`} className="archer-project-settings-section">
          {heading("Feedback", <LockIcon />)}
          {s.feedback === null ? (
            <p className="archer-project-settings-hint">Feedback settings are unavailable on this service.</p>
          ) : (
            <>
              <dl className="archer-project-settings-facts">
                <dt>Changes</dt>
                <dd>
                  {VALUE_LABEL[s.feedback.changes] ?? s.feedback.changes}{" "}
                  <span className="archer-project-settings-meta">
                    {SOURCE_LABEL[s.feedback.sources.changes] ?? s.feedback.sources.changes}
                  </span>
                </dd>
                <dt>Delivery</dt>
                <dd>
                  {VALUE_LABEL[s.feedback.delivery] ?? s.feedback.delivery}{" "}
                  <span className="archer-project-settings-meta">
                    {SOURCE_LABEL[s.feedback.sources.delivery] ?? s.feedback.sources.delivery}
                  </span>
                </dd>
                <dt>Notifications</dt>
                <dd>
                  {s.feedback.allowNotifications ? "Allowed" : "Not allowed"}{" "}
                  <span className="archer-project-settings-meta">
                    {SOURCE_LABEL[s.feedback.sources.allowNotifications] ?? s.feedback.sources.allowNotifications}
                  </span>
                </dd>
              </dl>
              <p className="archer-project-settings-hint">
                Change in archer.toml, under <code>[feedback]</code>.
              </p>
            </>
          )}
        </section>

        <section aria-labelledby={`${sectionId}-5`} className="archer-project-settings-section">
          <div className="archer-project-settings-label archer-project-settings-section-label">
            <ChangeDot change={change("visibility")} />
            {heading("Visibility")}
          </div>
          <div className="archer-project-settings-status" data-status={status.toLowerCase()}>
            <span aria-hidden="true" className="archer-project-settings-status-dot" />
            <span>
              Status: <strong>{status}</strong>
            </span>
            {inactive ? (
              <Tip
                className="archer-project-settings-info"
                label="Why is this project inactive?"
                tip={inactiveReason(s.visibility)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.25" />
                  <path d="M8 7.2v3.8M8 5h.01" />
                </svg>
              </Tip>
            ) : null}
          </div>
          <div
            role="radiogroup"
            aria-label="Visibility"
            aria-disabled={visibilityLocked || undefined}
            className="archer-project-settings-segments"
          >
            {(["auto", "visible", "hidden"] as const).map((option) => (
              <label
                key={option}
                data-checked={visibility === option || undefined}
                data-disabled={visibilityLocked || undefined}
              >
                <input
                  type="radio"
                  name={`${sectionId}-visibility`}
                  value={option}
                  checked={visibility === option}
                  disabled={visibilityLocked || saving}
                  onChange={() => {
                    if (!visibilityLocked && !saving) setDraft((d) => ({ ...d, visibility: option }));
                  }}
                />
                {VISIBILITY_LABEL[option]}
              </label>
            ))}
          </div>
          {visibilityLocked ? (
            <p className="archer-project-settings-hint">
              Editing is off for this project, so its visibility can't be changed here, like Edit and New. Turn editing
              on in archer.toml to archive or show it.
            </p>
          ) : null}
          <p className="archer-project-settings-hint">
            Automatic moves a project to Inactive when it has had no documents for ten minutes, and back when one
            appears. Always show keeps it listed even when it has no documents, overriding Inactive; Archive hides it.
            Pages and files stay available either way.
          </p>
        </section>

        <section aria-labelledby={`${sectionId}-6`} className="archer-project-settings-section">
          {heading("archer.toml", <LockIcon />)}
          {s.manifest === null ? (
            <p className="archer-project-settings-hint">No archer.toml. This project runs on defaults.</p>
          ) : (
            <pre
              className="archer-project-settings-manifest"
              role="region"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02).
              tabIndex={0}
              aria-label="archer.toml contents"
            >
              {s.manifest.text}
            </pre>
          )}
        </section>
      </>
    );
  };

  const subtitle =
    snapshot === null ? (
      props.projectName
    ) : (
      <>
        {props.projectName} ·{" "}
        <code>
          {homeRelative(snapshot.general.location)}
          {snapshot.manifest === null ? "" : `/${snapshot.manifest.path}`}
        </code>
      </>
    );
  const ready = phase === "ready" && snapshot !== null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes on a click on itself only; the keyboard closes the dialog with Escape, handled inside it.
    <div
      className="archer-project-settings-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialog}
        className="archer-project-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-ready={ready || undefined}
      >
        <header className="archer-project-settings-header">
          <div>
            <h2 id={titleId}>Project Settings</h2>
            <span className="archer-project-settings-subtitle">{subtitle}</span>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="archer-project-settings-close"
            aria-label="Close settings"
            title="Close settings"
            onClick={requestClose}
            disabled={saving}
          >
            <CloseGlyph />
          </button>
        </header>
        {ready ? (
          <nav className="archer-project-settings-nav" aria-label="Settings sections">
            {SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                aria-current={current === section ? "true" : undefined}
                onClick={() => goTo(section)}
              >
                {section}
                {count(section) === undefined ? null : <span>{count(section)}</span>}
              </button>
            ))}
            <p className="archer-project-settings-nav-hint">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
              </svg>
              <span>Protected fields are read-only here; change them in archer.toml.</span>
            </p>
          </nav>
        ) : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: scroll and pointer events tell the section spy that the reader scrolled; no action is taken on them. */}
        <div
          ref={content}
          className="archer-project-settings-content"
          onScroll={ready ? onScroll : undefined}
          onScrollEnd={ownScroll}
          onWheel={ownScroll}
          onTouchStart={ownScroll}
          onPointerDown={ownScroll}
          onKeyDown={ownScroll}
        >
          {error ? (
            <div className="archer-project-settings-error" role="alert">
              <span>{error.message}</span>
              {error.conflict || phase === "failed" ? (
                <button type="button" onClick={() => setReload((value) => value + 1)}>
                  {error.conflict ? "Reload" : "Try again"}
                </button>
              ) : null}
            </div>
          ) : null}
          {phase === "loading" ? (
            <p className="archer-project-settings-placeholder" role="status">
              Loading project settings…
            </p>
          ) : null}
          {ready ? body(snapshot) : null}
        </div>
        <footer className="archer-project-settings-footer">
          {!ready ? (
            <>
              <span />
              <div className="archer-project-settings-actions">
                <button type="button" className="archer-project-settings-secondary" onClick={close}>
                  Close
                </button>
              </div>
            </>
          ) : confirming ? (
            <>
              <span className="archer-project-settings-count">Discard {plural(changes.length, "unsaved change")}?</span>
              <div className="archer-project-settings-actions">
                <button
                  ref={keepEditing}
                  type="button"
                  className="archer-project-settings-secondary"
                  onClick={keepEditingNow}
                >
                  Keep editing
                </button>
                <button type="button" className="archer-project-settings-danger" onClick={close}>
                  Discard
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="archer-project-settings-count" aria-live="polite">
                {changes.length > 0 ? <span aria-hidden="true" className="archer-project-settings-count-dot" /> : null}
                {plural(changes.length, "unsaved change")}
              </span>
              <div className="archer-project-settings-actions">
                <button type="button" className="archer-project-settings-secondary" onClick={close} disabled={saving}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="archer-project-settings-primary"
                  onClick={() => void save()}
                  disabled={!canSave}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>,
    portal,
  );
}
