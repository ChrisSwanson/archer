// Static discovery adaptations stay outside the live CLI/MCP and page graphs.
import {
  PLAYGROUND_BASE_OPERATIONS,
  withOutputFormat,
  closed,
  listProjectsAction,
  presentAction,
  presentEmphasisAction,
  type OperationDefinition,
} from "../../../shared/tool-definitions.mts";
/** Live output remains byte-for-byte stable; static copy retains the shared action and omits only live capabilities. */
export const playgroundDescription = (operation: OperationDefinition): string => {
  if (operation.name === "list_projects")
    return `${listProjectsAction} in the public examples, with names, slugs and page URLs. Changes stay in this browser.`;
  if (operation.name === "present_diagram")
    return `${presentAction}. ${presentEmphasisAction} Public examples only; changes stay in this browser.`;
  return (
    operation.description
      .replace(" Starts the service if needed.", "")
      .replace(" Does not start the service.", "")
      .replace(" Their reply comes back through get_comments.", "") +
    " Public examples only; changes stay in this browser."
  );
};
export const PLAYGROUND_TOOLS = Object.values(PLAYGROUND_BASE_OPERATIONS).map((operation) => ({
  ...withOutputFormat(operation),
  ...(operation.name === "present_diagram"
    ? {
        inputSchema: {
          ...withOutputFormat(operation).inputSchema,
          properties: Object.fromEntries(
            Object.entries(withOutputFormat(operation).inputSchema.properties!).filter(
              ([name]) => name !== "expand" && name !== "annotation",
            ),
          ),
        },
      }
    : {}),
  description: playgroundDescription(operation),
}));

/** Browser playback controls the mounted player; it is deliberately separate from MCP presentation. */
export const PLAY_WALKTHROUGH: OperationDefinition = {
  name: "play_walkthrough",
  description:
    "Play or pause the saved walkthrough currently open in the public example. Changes stay in this browser.",
  inputSchema: closed({ action: { type: "string", enum: ["play", "pause"] } }, ["action"]),
};
