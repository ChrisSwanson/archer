/**
 * Where the reader is: Projects (the all-project overview, on a served page),
 * then the project, then every folder on the
 * way to what is open, then what is open (`folders.ts`). The project goes to
 * the overview; a folder shows what that folder holds (`FolderPage.tsx`); a
 * diagram embedded in a note has its note as a segment, which goes back to
 * the note where the reader was.
 * What is open is the last segment, marked as the current page; it is text,
 * since going to it would go nowhere.
 *
 * On a phone the trail shares a row with the menu and the workspace actions, so
 * it shows only the way up one level, after a "…" that opens the whole path
 * (round 1, #12: squeezed to fit, every segment had shrunk to an unreadable,
 * untappable stub). The segments it hides are marked `data-far`. The "…" is a
 * control for the trail, not one of its segments, so it sits just before the nav.
 */
import { Fragment, useId, useState, type JSX } from "react";
import type { FolderCrumb } from "./folders";

export type BreadcrumbProps = {
  readonly project: string;
  /** The folders before the current segment, outermost first. */
  readonly trail: readonly FolderCrumb[];
  /** What is open: a diagram's or note's title or a folder's name; null on the project's own page. */
  readonly current: string | null;
  /** The all-project overview, where the page has one. */
  readonly onProjects?: () => void;
  /** The project's own browser is open: its segment is the current page, not a link. */
  readonly projectCurrent?: boolean;
  /** The note a diagram embedded in it lives in (ADR 0012): a segment that goes back to it. */
  readonly note?: { readonly name: string; readonly path: string };
  readonly onProject: () => void;
  readonly onFolder: (path: string) => void;
  readonly onNote?: (path: string) => void;
};

const Separator = ({ far = false }: { readonly far?: boolean }): JSX.Element => (
  <span aria-hidden="true" data-far={far ? "" : undefined}>
    /
  </span>
);

export function Breadcrumb({
  project,
  trail,
  current,
  note,
  onProjects,
  projectCurrent,
  onProject,
  onFolder,
  onNote,
}: BreadcrumbProps): JSX.Element {
  const [whole, setWhole] = useState(false);
  const navId = useId();
  const atProject = projectCurrent === true && current === null && trail.length === 0 && note === undefined;
  // Every link on the way, outermost first; on a phone only the last is shown until the whole path is asked for.
  type Link = { readonly key: string; readonly render: (far: boolean) => JSX.Element };
  const mark = (far: boolean): { "data-far"?: "" } => (far ? { "data-far": "" } : {});
  const links: Link[] = [
    ...(onProjects === undefined
      ? []
      : [
          {
            key: "projects",
            render: (far: boolean) => (
              <button type="button" {...mark(far)} onClick={onProjects}>
                Projects
              </button>
            ),
          },
        ]),
    ...(atProject
      ? []
      : [
          {
            key: "project",
            render: (far: boolean) => (
              <button type="button" {...mark(far)} onClick={onProject}>
                {project}
              </button>
            ),
          },
        ]),
    ...trail.map((folder) => ({
      key: `folder:${folder.path}`,
      render: (far: boolean) => (
        <button type="button" {...mark(far)} title={folder.path} onClick={() => onFolder(folder.path)}>
          {folder.name}
        </button>
      ),
    })),
    ...(note === undefined
      ? []
      : [
          {
            key: "note",
            render: (far: boolean) => (
              <button type="button" {...mark(far)} title={`Back to ${note.path}`} onClick={() => onNote?.(note.path)}>
                {note.name}
              </button>
            ),
          },
        ]),
  ];
  const shown = current ?? (atProject ? project : null);
  const items: { readonly key: string; readonly far: boolean; readonly node: JSX.Element }[] = [
    ...links.map((link, at) => ({
      key: link.key,
      far: at < links.length - 1,
      node: link.render(at < links.length - 1),
    })),
    ...(shown === null ? [] : [{ key: "current", far: false, node: <span aria-current="page">{shown}</span> }]),
  ];
  const hides = items.some((item) => item.far);
  return (
    <>
      {hides ? (
        <span className="primary-breadcrumb-more-wrap">
          <button
            type="button"
            className="primary-breadcrumb-more"
            aria-label="Show the whole path"
            title="Show the whole path"
            aria-expanded={whole}
            aria-controls={navId}
            onClick={() => setWhole(!whole)}
          >
            …
          </button>
          <span aria-hidden="true">/</span>
        </span>
      ) : null}
      <nav id={navId} aria-label="Breadcrumb" className="primary-breadcrumb" data-whole={whole ? "" : undefined}>
        {items.map((item, at) => (
          <Fragment key={item.key}>
            {/* A separator next to a hidden segment is hidden with it; the "…" brings its own. */}
            {at === 0 ? null : <Separator far={items[at - 1]!.far} />}
            {item.node}
          </Fragment>
        ))}
      </nav>
    </>
  );
}
