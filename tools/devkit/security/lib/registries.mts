// Run under tsx by the security tools: prints, as one JSON line, the route and method tables the code
// itself declares, so the inventory classifies from the code rather than a copy of it.
import { debugAccess, MAX_CLIENT_BATCH_BYTES } from "../../../../ts/src/service/debug-http.ts";
import { AGENT_METHODS, LISTENER_ROUTES } from "../../../../ts/src/agents/contract.ts";
import { OPERATIONS } from "../../../../ts/src/application/index.ts";
import { BROWSER_OPERATIONS } from "../../../../ts/src/service/browser-operations.ts";
import {
  MAX_COMMENTS_BODY_BYTES,
  MAX_PAIR_BODY_BYTES,
  MAX_SELECTION_BODY_BYTES,
} from "../../../../ts/src/service/http.ts";
import { MAX_AUTHORING_HTTP_BYTES } from "../../../../ts/src/service/authoring-http.ts";
import { MAX_PROJECT_LIFECYCLE_BODY_BYTES } from "../../../../ts/src/service/project-lifecycle.ts";
import { MAX_NOTE_EMPHASIS_FILE_BYTES } from "../../../../shared/note-emphasis.mts";
import { MAX_EVENT_STREAMS, MAX_EVENT_STREAMS_PER_GRANT } from "../../../../ts/src/service/streams.ts";
import { MAX_REQUEST_LINE_BYTES } from "../../../../ts/src/service/socket.ts";

export function registries() {
  const debug: Record<string, string> = {};
  for (const [method, name] of [
    ["GET", "health"],
    ["GET", "metrics"],
    ["GET", "log"],
    ["GET", "events"],
    ["POST", "events"],
    ["POST", "reset"],
    ["POST", "profile/cpu"],
    ["POST", "heap-snapshot"],
  ] as const)
    debug[`${method} ${name}`] = debugAccess(method, name);
  return {
    debugAccess: debug,
    agentMethods: [...AGENT_METHODS],
    operations: OPERATIONS.map((op) => ({ name: op.name, ...(op.annotations ? { annotations: op.annotations } : {}) })),
    browserOperations: [...BROWSER_OPERATIONS],
    listenerRoutes: LISTENER_ROUTES,
    caps: {
      MAX_PAIR_BODY_BYTES,
      MAX_COMMENTS_BODY_BYTES,
      MAX_SELECTION_BODY_BYTES,
      MAX_AUTHORING_HTTP_BYTES,
      MAX_PROJECT_LIFECYCLE_BODY_BYTES,
      MAX_NOTE_EMPHASIS_FILE_BYTES,
      MAX_CLIENT_BATCH_BYTES,
      MAX_LISTENER_BODY_BYTES: 1024,
      "1024": 1024,
      MAX_EVENT_STREAMS,
      MAX_EVENT_STREAMS_PER_GRANT,
      MAX_REQUEST_LINE_BYTES,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(`${JSON.stringify(registries())}\n`);
