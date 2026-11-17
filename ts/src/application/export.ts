// Neutral export operation: adapters consume the same bytes and provenance.
import {
  exportDiagram,
  assertProjectNotice,
  ExportRefusal,
  EXPORT_LIMITS,
  type ExportOptions,
  type ExportResources,
} from "../export/index.ts";
import { readConfined } from "../project/confined-fs.ts";
import { exportFontFaces, installationAsset } from "../assets.ts";
import { FONT_LICENSE_ASSET } from "../export/resources.ts";
import type { Diagnostic } from "../mermaid/diagnostics.ts";
import type { Emphasis } from "../service/emphasis.ts";
import { serviceError, toolError } from "./errors.ts";
import type { OperationResult } from "./index.ts";

/** Read only the project's own regular notice; a link must never disclose another file. */
function readProjectNotice(root: string): string | undefined {
  try {
    const bytes = readConfined(root, ["NOTICE.md"], { shown: "NOTICE.md", limit: EXPORT_LIMITS.stringLength });
    const notice = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    assertProjectNotice(notice);
    return notice;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ExportRefusal(
      "export_notice_invalid",
      "NOTICE.md must be a regular, singly linked UTF-8 file of at most 100000 bytes with valid XML text. Correct it before exporting.",
    );
  }
}

function packagedResources(): ExportResources {
  try {
    return {
      themeCss: installationAsset("export/theme.css").toString("utf8"),
      fontLicense: installationAsset(`export/${FONT_LICENSE_ASSET}`).toString("utf8"),
      fontFaces: exportFontFaces(),
      wasmBytes: installationAsset("export/index_bg.wasm"),
    };
  } catch {
    throw toolError(
      "export_resources_missing",
      "The installation is missing an export resource. Reinstall the complete Archer distribution.",
    );
  }
}

export async function runExportOperation(
  read: Record<string, unknown>,
  args: Readonly<Record<string, unknown>>,
  emphasisSnapshot?: Record<string, unknown>,
  annotation?: string,
  projectRoot?: string,
): Promise<OperationResult> {
  if (!read["envelope"])
    throw toolError("diagram_not_found", "There is no compiled drawing to export. Read its source diagnostics first.");
  const compile = read["compile"] as { diagnostics: readonly Diagnostic[] };
  const views = emphasisSnapshot?.["views"] as { emphases: readonly Emphasis[] }[] | undefined;
  try {
    const projectNotice = projectRoot === undefined ? undefined : readProjectNotice(projectRoot);
    const options: ExportOptions = {
      ...(projectNotice === undefined ? {} : { projectNotice }),
      resources: packagedResources(),
      format: (args["format"] ?? "svg") as "svg" | "png",
      mode: (args["mode"] ?? "diagram") as "diagram" | "presentation",
      theme: (args["theme"] ?? "dark") as "light" | "dark",
      scale: (args["scale"] ?? 1) as number,
      allowLastGood: args["allowLastGood"] === true,
      noticeCaption: args["noticeCaption"] === true,
      source: { revision: read["sourceRevision"] as string | null, diagnostics: compile.diagnostics },
      presentation: {
        emphases: views?.[0]?.emphases ?? [],
        ...(args["activeEmphasisId"] === undefined
          ? {}
          : { activeEmphasisId: args["activeEmphasisId"] as string | null }),
        ...(annotation === undefined ? {} : { annotation }),
        diagramKey: args["diagramKey"] !== false,
        ...(args["accessible"] === true ? { accessible: true } : {}),
      },
    };
    const rendered = await exportDiagram(read["envelope"], options);
    const { bytes, ...metadata } = rendered;
    return {
      text: `${rendered.mimeType === "image/png" ? "PNG" : "SVG"} ${rendered.width} × ${rendered.height}; ${bytes.length} bytes; ${options.mode}, ${options.theme}; revision ${rendered.revision}${rendered.lastGood ? "; explicitly accepted last-good drawing" : ""}. Full bytes: outputFormat=json, or CLI --output <path>.`,
      structured: {
        ...metadata,
        format: options.format,
        mode: options.mode,
        theme: options.theme,
        encoding: "base64",
        data: Buffer.from(bytes).toString("base64"),
      },
    };
  } catch (failure) {
    if (failure instanceof ExportRefusal) throw serviceError(failure.code, failure.message);
    throw failure;
  }
}
