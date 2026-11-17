// Convenient aliases for shared application operations; the generic call command
// exposes the same validation and behavior without a transport bridge.
import { parseArgs } from "node:util";
import { UsageError, usage, type Io } from "./main.ts";
import { executeOperation, readPayload } from "./operations.ts";

export async function run(args: readonly string[], io: Io): Promise<number> {
  const [action, ...rest] = args;
  const { values, positionals } = usage(() =>
    parseArgs({
      args: rest,
      options: { json: { type: "boolean" }, file: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }),
  );
  let name: string;
  let payload: Record<string, unknown>;
  if (action === "list") {
    if (positionals.length > 1 || values.file !== undefined)
      throw new UsageError("emphasis list takes an optional viewId and --json");
    name = "list_emphases";
    payload = positionals[0] === undefined ? {} : { viewId: positionals[0] };
  } else if (action === "set") {
    if (positionals.length !== 0 || values.file === undefined)
      throw new UsageError("emphasis set needs --file <set_emphasis.json>");
    name = "set_emphasis";
    payload = readPayload(values.file, io);
  } else if (action === "clear") {
    if (positionals.length !== 2 || values.file !== undefined)
      throw new UsageError("emphasis clear needs <viewId> <emphasisId>");
    name = "set_emphasis";
    payload = { viewId: positionals[0], id: positionals[1], groups: [] };
  } else throw new UsageError("emphasis needs list, set or clear");

  return executeOperation(name, payload, io, values.json === true || action === "list");
}
