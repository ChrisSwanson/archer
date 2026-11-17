# Project documentation coverage

The project browser discovers Markdown and Mermaid within the project's authoring folder,
normally `.archer/`, plus the project's root `README.md` (exact name, a regular file, not a
symlink). Existing custom `folder` settings remain the default. The root README is the only file
outside the folder admitted by default; it is read-only, and its absence is not a diagnostic. It
stays admitted whatever `roots` lists, including `roots = []`; `exclude = ["README.md"]` removes
it.

Archer never writes discovered content. The service writes project files only inside the
Archer folder, creates new ones only under its `diagrams/` and `notes/`, and outside the folder writes
only an existing `archer.toml` (`[[views]]` via `register_diagram`). To include more content, configure global or project `archer.toml`:

```toml
[discovery]
roots = [".archer", "docs"]
exclude = ["docs/generated/**"]
```

Each project field overrides its global default. Lists replace rather than append; `roots = []`
discovers only the root README. Roots are literal project-relative files/directories. `"."` explicitly opens
discovery to the project root. Absolute paths, parent traversal, backslashes and root globs are
refused. Exclusions support `*` within a path component and `**` across components; no regex,
negation, braces or extglobs. Exclusion wins over an included root.

Hidden descendants and generated/dependency folders (`node_modules`, `target`, `dist`, `build`,
`coverage`, `vendor`) are omitted unless explicitly named as roots. Symlinks are not followed.
Overlapping roots produce one document; only folders containing documents appear. The project
description is `description` in `archer.toml`, else the root README's first paragraph; an excluded
README gives none. Archer-folder content, not the root README, decides whether a project is empty.

Existing authoring-folder documents retain their note/view IDs, comments and highlights. Additional
sources open read-only Markdown and Mermaid previews. Broader discovery grants no source or sidecar
writes; it does not move existing annotations. Legacy authoring APIs retain their existing identities.

Discovery is bounded: 64 roots, 128 exclusion patterns, 64 directory levels, 1,000 directories,
50,000 encountered entries, 4,096 documents and 16 MiB of aggregate source sizes. Markdown reads
are at most 1 MiB; Mermaid reads at most 256 KiB. Missing/unreadable roots and reached budgets produce
an incomplete catalog with named diagnostics. Narrow the configured roots rather than assuming a
partial catalog includes everything.

Confined discovery uses verified descriptor-relative filesystem access where it exists: Linux
`/proc/self/fd`, or a `/dev/fd` with the same directory-relative and binding checks. Elsewhere
(macOS, whose `/dev/fd` has no directory-relative names, and Linux without `/proc`) it runs on the
path anchor: every segment is lstat-walked before and after each open and compared with the
descriptor, and a link on the way is refused (its residual race is
[known limit §1](security/known-limits.md)). Neither follows a link. Descriptor anchoring prevents
parent symlink redirection; observed renames out of scope are refused before publishing content.
It does not lock files against an OS process that already has permission to move or edit them.

The path anchor names every file by its absolute path, and macOS refuses a path over 1024 bytes
(`PATH_MAX`). A document deeper than that inside the project cannot be read there: its folder is
reported `directory_unreadable` and the catalog is incomplete, so `read_note` answers
`io_failure` with `reason: coverage_incomplete`, never "not found". Linux's limit is 4096 bytes,
and the descriptor anchor opens each segment from the one before it, so there only the 1200-character
note-path bound applies.
