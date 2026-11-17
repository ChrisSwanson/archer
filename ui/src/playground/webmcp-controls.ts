/** The real App's actions, bound only while its current static project is mounted. */
export interface StaticControls {
  present(
    input: { viewId: string; walkthrough?: { id: string; step?: number } },
    signal: AbortSignal,
  ): Promise<unknown>;
  controlWalk(input: { action: "play" | "pause" }, signal: AbortSignal): Promise<unknown>;
  context(): { projectSlug: string; viewId?: string };
}
