import { PROJECT_README, type DiscoverySettings } from "../project/discovery.ts";
import type { ProjectLifecycleMetadata } from "../state/project-lifecycle.ts";
import type { ProjectState } from "./project-state.ts";

/** Public catalog metadata, shared by the HTTP catalog and public example snapshots. */
export function projectSummary(
  attached: ProjectState,
  lifecycle: ProjectLifecycleMetadata,
  includeDocuments: boolean,
  settings?: DiscoverySettings,
) {
  const documents = attached.documentCatalog(settings);
  const readme = documents.documents.find((document) => document.source.path === PROJECT_README);
  const description = attached.description ?? readme?.description;
  const views = attached.inventory().views;
  const notes = attached.allNotes().notes;
  return {
    slug: attached.slug,
    name: attached.name,
    ...(attached.repository?.worktree === undefined ? {} : { worktree: attached.repository.worktree }),
    ...(description === undefined ? {} : { description }),
    ...(readme === undefined ? {} : { readme: { path: readme.source.path } }),
    lifecycle,
    views,
    notes,
    facts: attached.facts(views, notes),
    ...(includeDocuments ? { documents } : {}),
  };
}
