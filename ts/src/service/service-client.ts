// The front doors' shared management-plane client (ts/src/service/protocol.ts):
// newline-delimited JSON over the service's Unix socket, one request per line,
// answers matched by id. The server never starts the service itself; it asks
// an injected `ensureService` for a connected client the first time a tool
// needs the browser, and the real one comes from the service slice.
import { connect, type Socket } from "node:net";
import {
  PROTOCOL_VERSION,
  SERVICE_NAME_PATTERN,
  type Method,
  type Request,
  type Results,
  type ServiceError,
} from "./protocol.ts";
import { withSandboxHint } from "./sandbox.ts";
import { socketProblem } from "./paths.ts";

type ParamsOf<M extends Method> = Extract<Request, { method: M }>["params"];

export interface ServiceClient {
  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<Results[M]>;
  close(): void;
  /** Settles when the connection has closed, from either end (a hand-over's old service ends it once it lets go). */
  ended?(): Promise<void>;
  /** The running service's application version, as its hello said. */
  readonly serviceVersion?: string;
}

/** Starts the service if it is not running, and connects to it. */
export type EnsureService = () => Promise<ServiceClient>;

/** A refusal or failure from the service, carrying its error (ADR 0002 vocabulary). */
export class ServiceCallError extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
    this.name = "ServiceCallError";
  }
}

/** The service could not be reached or started at all. */
export class ServiceUnavailableError extends Error {
  override name = "ServiceUnavailableError";
}

/** The service on the socket speaks another protocol version. */
export class ProtocolMismatchError extends ServiceUnavailableError {
  override name = "ProtocolMismatchError";
  constructor(
    readonly hello: { readonly version: string; readonly protocolVersion: number },
    message: string,
  ) {
    super(message);
  }
}

/** The service a front door started stopped before answering: starting it again would only fail again. */
export class ServiceStartError extends ServiceUnavailableError {
  override name = "ServiceStartError";
}

/** A running copy of Archer, as a front door's choice lists it (ADR 0031). */
export interface RunningCopy {
  readonly kind: "main" | "isolated";
  readonly version: string;
  readonly protocolVersion: number;
  readonly stateDir: string;
  readonly url?: string;
  readonly pid?: number;
  /** False for a build from before the registry, found only through its socket. */
  readonly registered: boolean;
}

export interface InstanceChoiceOption {
  readonly id: "reuse-main" | "reuse-any" | "start-new" | "restart-main" | "stop-main";
  readonly label: string;
  /** What to run once the person has chosen it; then try again. */
  readonly run: string;
}

export interface InstanceChoice {
  readonly reason: "main_older" | "main_incompatible" | "other_copies";
  readonly mode: "ask" | "reuse-main" | "reuse-any";
  readonly running: readonly RunningCopy[];
  readonly options: readonly InstanceChoiceOption[];
  readonly preferences: string;
  readonly warnings: readonly string[];
}

/**
 * Which running copy to use is the person's choice (ADR 0031): ask them, record the answer with
 * `archer preferences set`, and try again. Not a ServiceUnavailableError: a retry asks again.
 */
export class InstanceChoiceError extends Error {
  override readonly name = "InstanceChoiceError";
  readonly code = "instance_choice_needed";
  constructor(
    message: string,
    readonly details: InstanceChoice,
  ) {
    super(message);
  }
}

/** The most bytes one answer line may hold before the connection is dropped. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Connects to the service at `socketPath` and checks it speaks this protocol. */
export async function connectService(
  socketPath: string,
  expectedServiceName?: string,
  signal?: AbortSignal,
): Promise<ServiceClient> {
  if (expectedServiceName !== undefined && !SERVICE_NAME_PATTERN.test(expectedServiceName))
    throw new ServiceUnavailableError("the expected service name must match ^[a-z0-9][a-z0-9-]{0,31}$");
  const aborted = (): ServiceUnavailableError =>
    new ServiceUnavailableError("Archer service connection was cancelled or timed out");
  if (signal?.aborted) throw aborted();
  // Nothing is sent to a socket that is not ours, in a directory that is not private (R4, C-26).
  const unsafe = socketProblem(socketPath);
  if (unsafe !== undefined) throw new ServiceUnavailableError(withSandboxHint(unsafe));
  let socket: Socket | undefined;
  let client: SocketClient | undefined;
  let rejectConnection: ((error: Error) => void) | undefined;
  const cancel = (): void => {
    rejectConnection?.(aborted());
    client?.close();
    socket?.destroy();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    socket = await new Promise<Socket>((resolve, reject) => {
      rejectConnection = reject;
      const s = connect(socketPath);
      socket = s;
      s.once("connect", () => resolve(s));
      s.once("error", (error) =>
        reject(
          signal?.aborted
            ? aborted()
            : new ServiceUnavailableError(
                withSandboxHint(
                  `cannot reach the Archer service: ${(error as NodeJS.ErrnoException).code ?? error.message}`,
                ),
              ),
        ),
      );
      if (signal?.aborted) cancel();
    });
    if (signal?.aborted) throw aborted();
    client = new SocketClient(socket);
    let hello: Results["hello"];
    try {
      hello = await client.call("hello", { protocolVersion: PROTOCOL_VERSION });
    } catch (error) {
      // A build speaking another protocol refuses this one's hello (service.ts); its version is unknown.
      if (!(error instanceof ServiceCallError) || error.error.code !== "protocol_version_mismatch") throw error;
      const spoken = Number(/speaks protocol (\d{1,6})/.exec(error.error.message)?.[1] ?? -1);
      throw new ProtocolMismatchError(
        { version: "unknown", protocolVersion: spoken },
        `the running Archer service speaks protocol ${spoken < 0 ? "another" : spoken}, and this server speaks ${PROTOCOL_VERSION}; run \`archer stop\` and try again`,
      );
    }
    if (signal?.aborted) throw aborted();
    if (hello.protocolVersion !== PROTOCOL_VERSION)
      throw new ProtocolMismatchError(
        hello,
        `the running Archer service (${hello.version}) speaks protocol ${hello.protocolVersion}, and this server speaks ${PROTOCOL_VERSION}; run \`archer stop\` and try again`,
      );
    client.serviceVersion = hello.version;
    if (expectedServiceName !== undefined && hello.serviceName !== expectedServiceName) {
      const reported =
        typeof hello.serviceName === "string" ? JSON.stringify(hello.serviceName) : "no service identity";
      throw new ServiceUnavailableError(
        `expected service ${JSON.stringify(expectedServiceName)}, but the service on ${socketPath} reports ${reported}; check the selected service and socket`,
      );
    }
    return client;
  } catch (error) {
    client?.close();
    socket?.destroy();
    if (signal?.aborted) throw aborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

class SocketClient implements ServiceClient {
  serviceVersion?: string;
  private next = 1;
  private buffered = "";
  private readonly pending = new Map<number, Pending>();
  private closed: Error | null = null;
  private readonly gone: Promise<void>;

  constructor(private readonly socket: Socket) {
    this.gone = new Promise<void>((done) => socket.once("close", () => done()));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.fail(new ServiceUnavailableError(`lost the Archer service: ${error.message}`)));
    socket.on("close", () => this.fail(new ServiceUnavailableError("the Archer service closed the connection")));
  }

  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<Results[M]> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<Results[M]>((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(r as Results[M]), reject });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  ended(): Promise<void> {
    return this.gone;
  }

  close(): void {
    this.fail(new ServiceUnavailableError("the connection to the Archer service was closed"));
    this.socket.destroy();
  }

  private receive(chunk: string): void {
    this.buffered += chunk;
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.answer(line);
      newline = this.buffered.indexOf("\n");
    }
    if (this.buffered.length > MAX_LINE_BYTES) {
      this.fail(new ServiceUnavailableError("the Archer service sent an answer too long to read"));
      this.socket.destroy();
    }
  }

  private answer(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      return this.fail(new ServiceUnavailableError("the Archer service sent something that is not JSON"));
    }
    if (typeof response !== "object" || response === null) return;
    const { id, ok, result, error } = response as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (pending === undefined) return;
    this.pending.delete(id as number);
    if (ok === true) pending.resolve(result);
    else
      pending.reject(
        new ServiceCallError(
          isServiceError(error) ? error : { code: "internal", message: "the Archer service failed without saying why" },
        ),
      );
  }

  private fail(error: Error): void {
    this.closed ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function isServiceError(value: unknown): value is ServiceError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ServiceError).code === "string" &&
    typeof (value as ServiceError).message === "string"
  );
}
