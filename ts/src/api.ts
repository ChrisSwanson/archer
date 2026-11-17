/** Composable Archer application API; transports adapt these operations. */
import { createApplication, type ApplicationOptions } from "./application/index.ts";
import { connectIfRunning, ensureService, type EnsureOptions } from "./service/client.ts";

export {
  createApplication,
  OPERATIONS,
  OperationError,
  type ApplicationOptions,
  type OperationResult,
} from "./application/index.ts";
export type { EnsureOptions } from "./service/client.ts";

/** Project-scoped operations with the same lazy local service policy as the CLI. */
export function openArcher(options: ApplicationOptions & { readonly service?: EnsureOptions }) {
  const { service, ...application } = options;
  return createApplication({
    ...application,
    ensureService: application.ensureService ?? (() => ensureService(service)),
    startService:
      application.startService ?? application.ensureService ?? (() => ensureService({ ...service, autoStart: true })),
    findService: application.findService ?? (() => connectIfRunning(service)),
  });
}

export { renderOperation, ReadableOutputError } from "./application/render.ts";
