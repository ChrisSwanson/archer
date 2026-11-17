// A thumbnail painter off the service's event loop (`ThumbnailPainters` in
// thumbnails.ts starts it). One message is one drawing: `{ id, envelope, theme }`
// in, `{ id, drawing }` (thumbnail-draw.ts: SVG and PNG; no zlib in here, O32) or
// `{ id, error }` out. The theme stylesheet and the raster resources arrive once,
// as workerData. It posts `{ ready: true }` once its modules have loaded, so the
// owner can tell a worker that cannot start from a drawing that failed.
import { parentPort, workerData } from "node:worker_threads";
import { drawThumbnail, type ThumbnailRasterResources } from "./thumbnail-draw.ts";
import type { ThumbnailTheme } from "./thumbnails.ts";

interface Job {
  readonly id: number;
  readonly envelope: unknown;
  readonly theme: ThumbnailTheme;
}

const port = parentPort;
if (port === null) throw new Error("thumbnail-worker runs as a worker thread");
const { themeCss, raster } = workerData as { themeCss: string; raster: ThumbnailRasterResources | null };

port.on("message", (job: Job) => {
  void drawThumbnail(job.envelope, job.theme, themeCss, raster).then(
    (drawing) => {
      const parts = [drawing.svg, drawing.br, drawing.gzip, drawing.png].filter(
        (part): part is Uint8Array => part instanceof Uint8Array,
      );
      // Each part owns its buffer (a fresh encoding), so it moves without a copy.
      const buffers = [...new Set(parts.map((part) => part.buffer as ArrayBuffer))];
      port.postMessage({ id: job.id, drawing }, buffers);
    },
    (failure: unknown) =>
      port.postMessage({
        id: job.id,
        error: failure instanceof Error ? failure.message : "The drawing could not be rendered.",
      }),
  );
});
port.postMessage({ ready: true });
