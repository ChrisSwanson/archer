// Offline convenience adapter for the shared measurement operation.
import { parseArgs } from "node:util";
import { findProject } from "../project/index.ts";
import { inventory } from "../application/diagrams.ts";
import { executeOperation, readSourceFile } from "./operations.ts";
import { resolveTarget } from "./commands.ts";
import { type Io, UsageError, usage } from "./main.ts";

export async function runMeasure(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = usage(() =>
    parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        states: { type: "string" },
        nested: { type: "boolean" },
        open: { type: "string" },
        canvas: { type: "string" },
        source: { type: "string" },
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        project: { type: "boolean" },
      },
    }),
  );
  if (values.project === true ? positionals.length !== 0 : positionals.length !== 1)
    throw new UsageError("measure needs one diagram name or file, or --project without a name");
  if (values.project === true && values.source !== undefined)
    throw new UsageError("measure --project takes no candidate --source; measure one diagram for a candidate");
  if (values.open !== undefined && values.nested !== true)
    throw new UsageError("--open needs --nested; give comma-separated group IDs");
  if (values.nested === true && values.states !== undefined)
    throw new UsageError("--nested and --states select different recipes; give one");
  const payload: Record<string, unknown> = {};
  if (values.states !== undefined) {
    const states = values.states.split(",");
    if (states.length > 8 || states.some((state) => state !== "full" && state !== "collapsed"))
      throw new UsageError("--states needs up to eight comma-separated full or collapsed states");
    payload["states"] = states.map((state) => (state === "full" ? { mode: "full" } : { mode: "nested", open: [] }));
  }
  if (values.nested === true) {
    const open = values.open === undefined ? [] : values.open.split(",");
    if (open.some((id) => id.length === 0))
      throw new UsageError("--open needs comma-separated group IDs without empty entries");
    payload["states"] = [{ mode: "nested", open }];
  }
  if (values.canvas !== undefined) {
    const size = /^(\d+)[xX](\d+)$/.exec(values.canvas);
    const width = Number(size?.[1]),
      height = Number(size?.[2]);
    if (size === null || width < 1 || height < 1 || width > 100000 || height > 100000)
      throw new UsageError("--canvas needs positive pixel dimensions WxH, at most 100000 each (for example 1025x896)");
    payload["viewport"] = { canvas: { width, height } };
  }
  if (values.project === true) payload["project"] = true;
  else {
    const project = findProject(io.cwd ?? process.cwd());
    const target = await resolveTarget(project, positionals[0]!, io);
    if ("address" in target) payload["viewId"] = target.address;
    else {
      const view = inventory(project).views.find(
        (item) => item.registration !== "embedded" && item.source === target.path,
      );
      if (view === undefined)
        throw new UsageError(`measure cannot address ${target.path}; archer list reports admitted diagrams`);
      payload["viewId"] = view.id;
    }
  }
  if (values.source !== undefined) payload["source"] = readSourceFile(values.source, io);
  return executeOperation("measure_diagram", payload, io, values.json === true, undefined, values.verbose === true);
}
