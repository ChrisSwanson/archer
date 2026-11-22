// A project and its Archer folder (ticket 09): finding it, reading
// archer.toml, keeping every path inside the folder, listing diagrams and
// notes, naming a diagram, compiling it, and `archer init`.
export { ProjectError, type ProjectErrorCode } from "./errors.ts";
export { groupIsPrivate } from "./ownership.ts";
export {
  confine,
  writeConfined,
  DEFAULT_FOLDER,
  findProject,
  historicalRegistry,
  type RegistryMetadata,
  MANIFEST,
  MAX_MANIFEST_BYTES,
  MAX_TITLE_CHARS,
  MAX_VIEWS,
  placeInFolder,
  readInFolder,
  readInFolderOrNull,
  readInProject,
  realFolder,
  removeInFolder,
  resolveInFolder,
  type ManifestProblem,
  type Project,
  type View,
} from "./project.ts";
export {
  listDiagrams,
  listNotes,
  MAX_NOTE_BYTES,
  readFrontMatter,
  splitFrontMatter,
  type DiagramEntry,
  type FrontMatter,
  type NoteEntry,
} from "./inventory.ts";
export { resolveDiagram, type ResolveOptions } from "./resolve.ts";
export { compileDiagram, compileDiagramBytes, revisionOf, type CompiledDiagram } from "./envelope.ts";
export {
  docsPointer,
  initProject,
  pointerSection,
  POINTER_BEGIN,
  POINTER_END,
  type InitOptions,
  type InitReport,
} from "./init.ts";
export { ConfinedRefusal, ConfinedTooLarge } from "./confined-fs.ts";
