/**
 * Whether the compile notice is over the canvas on screen.
 *
 * `App` renders the notice beside the canvas, not in it, so a canvas cannot
 * know from its own props that one has arrived. The framing keeps the
 * notice's sentence clear (`frameClearOfChrome`'s `notice`); this is what
 * tells it to frame again when the notice comes or goes, on the terms a
 * resize has -- only while the reader has not taken the camera.
 */
import { createContext, useContext } from "react";

export const CompileNoticeContext = createContext(false);

export function useCompileNoticeUp(): boolean {
  return useContext(CompileNoticeContext);
}
