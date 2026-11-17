import { fileRows, type FileRow, type IndexedProject } from "../../src/app/file-index";

/** Real rows through the production `fileRows`, from one inventory and one note listing. */
const project: IndexedProject = {
  slug: "archer",
  name: "Archer",
  current: true,
  views: [
    {
      id: "context",
      title: "Archer in its environment",
      kind: "c4",
      registration: "durable",
      sourcePath: "diagrams/overview/system-context.mmd",
      description: "Who uses Archer and which outside systems it talks to.",
      modifiedAt: "2026-10-12T10:00:00Z",
      createdAt: "2026-10-10T09:00:00Z",
      createdFrom: "git",
    },
    {
      id: "round-trip",
      title: "Comment round trip",
      kind: "sequence",
      registration: "durable",
      sourcePath: "diagrams/flows/comment-round-trip.mmd",
      description: "A reader comment travelling to the agent and the reply coming back.",
      modifiedAt: "2026-10-15T10:00:00Z",
      createdAt: "2026-10-10T09:00:00Z",
      createdFrom: "git",
      threads: { draft: 0, sent: 1, read: 0, answered: 0, resolved: 0 },
    },
    {
      id: "live-update",
      title: "Agent write to live update",
      kind: "sequence",
      registration: "durable",
      sourcePath: "diagrams/flows/agent-write-live-update.mmd",
      modifiedAt: "2026-10-11T10:00:00Z",
    },
  ],
  notes: [
    {
      path: "notes/decisions/page-shell.md",
      title: "Page shell",
      viewIds: [],
      description: "Why every page shares one shell.",
      modifiedAt: "2026-10-14T10:00:00Z",
      createdAt: "2026-10-01T09:00:00Z",
      createdFrom: "filesystem",
      threads: { draft: 0, sent: 0, read: 2, answered: 0, resolved: 0 },
    },
    {
      path: "notes/arch/accuracy.md",
      title: "accuracy review",
      viewIds: [],
      modifiedAt: "2026-10-16T10:00:00Z",
      createdAt: "2026-09-20T09:00:00Z",
      createdFrom: "filesystem",
    },
    {
      path: "glossary.md",
      title: "Glossary",
      viewIds: [],
      modifiedAt: "2026-10-02T10:00:00Z",
      createdAt: "2026-10-05T09:00:00Z",
      createdFrom: "git",
    },
  ],
};

const base = fileRows(project);
const byTitle = (title: string): FileRow => base.find((row) => row.title === title)!;

/** Comment activity and a note author, as the frame's rows carry them. */
export const rows: readonly FileRow[] = base.map((row) =>
  row.title === "Comment round trip"
    ? { ...row, totalThreads: 2, unresolvedThreads: 1 }
    : row.title === "Page shell"
      ? { ...row, totalThreads: 3, unresolvedThreads: 2, author: "agent" }
      : row.title === "Glossary"
        ? { ...row, author: "person" }
        : row,
) as readonly FileRow[];

export const row = (title: string): FileRow => rows.find((r) => r.title === title) ?? byTitle(title);
export const NOW = Date.parse("2026-10-18T12:00:00Z");
