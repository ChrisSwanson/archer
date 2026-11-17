// The one entry point for a terminal drawing: fit a graph model to a width
// and paint it.
import type { GraphInput } from "./input.ts";
import { fit } from "./layout.ts";
import { printable } from "./printable.ts";
import { render } from "./render.ts";

export interface DrawOptions {
  readonly width?: number | undefined;
  readonly color?: boolean | undefined;
  readonly title?: string | undefined;
}

export async function drawGraph(graph: GraphInput, options: DrawOptions = {}): Promise<string> {
  const width = options.width ?? 80;
  const body = render(await fit(graph, width), { color: options.color ?? false, width });
  // A title line first: a host that prefixes a command's first output line
  // (Claude Code writes the plugin's name there) shifts the title, not the drawing.
  return options.title === undefined ? body : `${printable(options.title)}\n${body}`;
}
