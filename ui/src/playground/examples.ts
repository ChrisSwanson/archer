import type { PlaygroundProject } from "../../../shared/playground-snapshot.mts";
import type { TargetRef } from "../comments/contract";
import type { ExampleMessage, RuntimeExamples } from "../app/runtime.ts";

/**
 * The Playground's example data for the surfaces a service would fill (owner, 2026-11-15): Archer Settings and the
 * chat. Every value here is illustrative; the surfaces that show it say so, and nothing here changes anything.
 */

/**
 * Archer Settings as a fresh install reports them (`ts/src/config/instance-settings.ts`, its built-in values), with
 * one line set in the person's own file so the source column has something to say.
 */
export const EXAMPLE_SETTINGS = {
  serviceName: "default",
  commentSubmission: "queued",
  configRevision: "example",
  configPath: "~/.config/archer/archer.toml",
  writable: false,
  settings: [
    { key: "edit", value: true, default: true, source: "builtin" },
    { key: "host", value: "127.0.0.1", default: "127.0.0.1", source: "builtin" },
    { key: "port", value: null, default: null, source: "builtin" },
    { key: "publicUrl", value: null, default: null, source: "builtin" },
    { key: "admission", value: "any", default: "any", source: "builtin" },
    { key: "openBrowser", value: "auto", default: "auto", source: "builtin" },
    { key: "autoStart", value: true, default: true, source: "builtin" },
    { key: "restore", value: true, default: true, source: "builtin" },
    { key: "commentSubmission", value: "queued", default: "immediate", source: "user" },
    { key: "pairingCodeMinutes", value: 5, default: 5, source: "builtin" },
    { key: "tlsCert", value: null, default: null, source: "builtin" },
    { key: "tlsKey", value: null, default: null, source: "builtin" },
    { key: "forceHttp", value: false, default: false, source: "builtin" },
  ],
} as const;

export const SETTINGS_NOTE =
  "Example settings: no Archer service is running here. Yours come from ~/.config/archer/archer.toml, environment variables and command-line flags.";

export const CHAT_NOTE =
  "In your own project, what you write here waits for your coding agent's next turn in your terminal.";

const person = (body: string): ExampleMessage => ({ author: "person", body });
const agent = (body: string): ExampleMessage => ({ author: "agent", body });

/** The tour's own conversations, written against its diagrams and notes. */
const TOUR: Readonly<Record<string, readonly ExampleMessage[]>> = {
  "project:": [
    person("Where should I start?"),
    agent(
      "With The Heartbeat Loop: play One Turn of the Heartbeat. What Is Archer? explains the product, and User Stories tells five sessions, each with the diagram that shows it.",
    ),
  ],
  "view:heartbeat": [
    person("Where do I come into this loop?"),
    agent(
      "At Person Selects and Comments. You select part of the picture and comment; I revise it and show it again, until it looks right. Then the code is built and the docs are kept with it.",
    ),
  ],
  "view:system-context": [
    person("Does Archer need the MCP host?"),
    agent(
      "No. The dashed line is the opt-in MCP path. I can drive Archer from the archer CLI alone; an MCP host adds its tools and the App.",
    ),
  ],
  "view:containers": [
    person("How does a diagram I ask for reach my browser?"),
    agent(
      "I write it into the project with the CLI or the MCP server, then present it. The background service watches the files and serves the Archer Page, which gets the update as a live event.",
    ),
  ],
  "view:deployment": [
    person("Which line crosses the network?"),
    agent(
      "Only the dashed one: the Archer Page on another device reaching the Background Service over paired HTTPS. Everything else stays on the agent's computer.",
    ),
  ],
  "view:feedback-loop": [
    person("When do you see my comments?"),
    agent(
      "When you send them. I read them on my next turn, revise the diagram and present it again; the loop repeats until we agree on the picture, before any code is written.",
    ),
  ],
  "view:answer-by-showing": [
    person("How does checkout work?"),
    agent(
      "I would not answer in prose. I find the diagram that holds checkout and light the path, or play its walkthrough when one covers the question. Nothing in its source changes.",
    ),
  ],
  "view:comment-thread": [
    person("What happens to a thread after you answer it?"),
    agent(
      "It is Answered until I resolve it. A reply from you takes it back to Draft; once resolved you can dismiss it, and only you ever see a draft.",
    ),
  ],
  "view:working-session": [
    person("Which step scores lowest today?"),
    agent(
      "The two at 3, both in Keep It True: staleness from covers and Git, and editing the diagram in the page. Everything from writing a diagram to resolving your comments scores 4 or 5.",
    ),
  ],
};

type Titled = { readonly title?: string; readonly description?: string };

/** A document's own words: its description, or its title when it has none. */
function describe(item: Titled | undefined, kind: "diagram" | "note"): string | null {
  if (item === undefined) return null;
  const title = item.title ?? `this ${kind}`;
  const summary = item.description?.trim();
  return summary
    ? `${summary} Ask me about any part of ${title} and I'll answer by highlighting it there.`
    : `Ask me about any part of ${title} and I'll answer by highlighting it there.`;
}

/** The example conversation for a target in a downloaded project: the tour's own, or one from its description. */
export function exampleChat(project: PlaygroundProject, target: TargetRef): readonly ExampleMessage[] | null {
  if (project.slug === "archer-tour" && TOUR[target]) return TOUR[target]!;
  if (target === "project:") {
    const readme = project.responses["api/documents/content?path=README.md"] as { markdown?: string } | undefined;
    const heading = readme?.markdown?.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    return [
      person("Where should I start?"),
      agent(
        heading
          ? `With the question its README asks: “${heading}” The README names the diagram and note to open first.`
          : "With the README: it names the diagram and note to open first.",
      ),
    ];
  }
  if (target.startsWith("view:")) {
    const views = (project.responses["api/diagrams"] as { views?: readonly (Titled & { id: string })[] } | undefined)
      ?.views;
    const answer = describe(
      views?.find((view) => view.id === target.slice(5)),
      "diagram",
    );
    return answer === null ? null : [person("What does this diagram show?"), agent(answer)];
  }
  if (target.startsWith("note:")) {
    const notes = (project.responses["api/notes/all"] as { notes?: readonly (Titled & { path: string })[] } | undefined)
      ?.notes;
    const answer = describe(
      notes?.find((note) => note.path === target.slice(5)),
      "note",
    );
    return answer === null ? null : [person("What is this note for?"), agent(answer)];
  }
  return null;
}

/** The static runtime's examples, reading the projects it has downloaded. */
export function playgroundExamples(project: (slug: string) => PlaygroundProject | undefined): RuntimeExamples {
  return {
    settingsNote: SETTINGS_NOTE,
    chatNote: CHAT_NOTE,
    // A fresh install's answer: only this computer can open Archer until the person opens it to their network.
    networkAccess: null,
    chat(slug, target) {
      const held = project(slug);
      return held === undefined ? null : exampleChat(held, target);
    },
  };
}
