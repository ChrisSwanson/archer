// @vitest-environment jsdom
// A note link whose answer needs a request (a project file outside the Archer folder): only the latest click's
// answer speaks. An earlier click's late failure, or one from before the reader left the note and came back, says
// nothing over what the person did since.
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { noteContent } from "../../ts/src/comments/notes";
import { findProject } from "../../ts/src/project";
import { NoteReader } from "../src/comments/NoteReader";
import type { ReviewModel } from "../src/comments/useReview";

afterEach(cleanup);

const project = findProject(resolve(import.meta.dirname, "../../examples/rfc-1149-ipoac"));
const guide = noteContent(project, "notes/reading-guide.md");
const other = noteContent(project, "notes/rfc1149.md");
// The guide with an external reference added, which opens in a new tab.
const withExternal = {
  ...guide,
  markdown: `${guide.markdown}\n\nSee [the RFC Editor](https://www.rfc-editor.org/).\n`,
};
const model = {
  capabilities: { notes: true },
  threads: new Map(),
  noteContents: new Map([
    [guide.path, { status: "ready", content: guide }],
    [other.path, { status: "ready", content: other }],
    ["notes/with-external.md", { status: "ready", content: { ...withExternal, path: "notes/with-external.md" } }],
  ]),
  actions: { openNote: vi.fn() },
} as unknown as ReviewModel;

function deferred(): { promise: Promise<boolean>; settle: (value: boolean) => Promise<void> } {
  let settle!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    settle = done;
  });
  return {
    promise,
    settle: async (value) => {
      await act(async () => {
        settle(value);
        await promise;
      });
    },
  };
}

const reader = (path: string, onOpenLink: (href: string) => boolean | Promise<boolean>) => (
  <NoteReader model={model} path={path} note={{ path, title: path }} onCompose={vi.fn()} onOpenLink={onOpenLink} />
);
const article = () => screen.getByRole("article");
const UNAVAILABLE = /^Unavailable:/u;

it("lets an earlier click's late failure say nothing once a newer click has answered", async () => {
  const notice = deferred();
  const onOpenLink = (href: string) => (href === "../../NOTICE.md" ? notice.promise : href === "rfc1149.md");
  render(reader(guide.path, onOpenLink));
  fireEvent.click(await within(article()).findByRole("link", { name: "the project notice" }));
  fireEvent.click(within(article()).getAllByRole("link", { name: "RFC 1149 in full" })[0]!);
  await notice.settle(false);
  expect(within(article()).queryByText(UNAVAILABLE)).toBeNull();
});

it("lets a failure from before the reader left the note and came back say nothing", async () => {
  const notice = deferred();
  const onOpenLink = () => notice.promise;
  const shown = render(reader(guide.path, onOpenLink));
  fireEvent.click(await within(article()).findByRole("link", { name: "the project notice" }));
  shown.rerender(reader(other.path, onOpenLink));
  shown.rerender(reader(guide.path, onOpenLink));
  await notice.settle(false);
  expect(within(article()).queryByText(UNAVAILABLE)).toBeNull();
});

it("still says the latest click's link is unavailable", async () => {
  const notice = deferred();
  render(reader(guide.path, () => notice.promise));
  fireEvent.click(await within(article()).findByRole("link", { name: "the project notice" }));
  await notice.settle(false);
  expect(within(article()).getByText(UNAVAILABLE)).toHaveTextContent("../../NOTICE.md");
});

it("still says the link is unavailable when the person meanwhile followed an external reference", async () => {
  const notice = deferred();
  render(reader("notes/with-external.md", (href) => (href === "../../NOTICE.md" ? notice.promise : false)));
  fireEvent.click(await within(article()).findByRole("link", { name: "the project notice" }));
  fireEvent.click(within(article()).getByRole("link", { name: "the RFC Editor" }));
  await notice.settle(false);
  expect(within(article()).getByText(UNAVAILABLE)).toHaveTextContent("../../NOTICE.md");
});
