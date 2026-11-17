// The local Archer service (ticket 07): its process, its management socket
// (protocol.ts) and its data plane (Archer's page per project).
export * from "./protocol.ts";
export type { SelectionContext } from "./selection.ts";
export {
  connectIfRunning,
  connectService,
  defaultServeCommand,
  ensureService,
  ServiceCallError,
  ServiceUnavailableError,
  type EnsureOptions,
  type EnsureService,
  type ServiceClient,
} from "./client.ts";
export { serveForeground } from "./foreground.ts";
export { serviceDirs, serviceSocketPath, type Env, type ServiceDirs } from "./paths.ts";
export {
  defaultPagePath,
  MAX_PROJECTS,
  ServiceRunningError,
  startService,
  type RunningService,
  type ServiceOptions,
} from "./service.ts";
