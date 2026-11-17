// ADR 0028: the page names where a new diagram may go before the service refuses it.
import { expect, it } from "vitest";
import { publishPathProblem } from "../src/authoring/useAuthoring";

it.each(["diagrams/checkout.mmd", "notes/decisions/flow.mmd", "diagrams/a/b/c.mmd"])("accepts %s", (path) => {
  expect(publishPathProblem(path)).toBeNull();
});

it.each(["checkout.mmd", "drafts/checkout.mmd", "Diagrams/checkout.mmd"])(
  "refuses %s outside diagrams/ and notes/",
  (path) => {
    expect(publishPathProblem(path)).toBe(
      "New diagrams go in diagrams/ or notes/, for example diagrams/checkout-flow.mmd.",
    );
  },
);

it("bounds the folders below diagrams/ as the service does", () => {
  const at = ["diagrams", ...Array.from({ length: 8 }, (_, i) => `d${i}`)].join("/");
  expect(publishPathProblem(`${at}/ok.mmd`)).toBeNull();
  expect(publishPathProblem(`${at}/more/no.mmd`)).toBe("A new diagram can be at most 8 folders below diagrams/.");
});

// A path written with "./" or "//" is inside the folder; saying it is outside is wrong (claude rescore 1, S4).
it.each(["diagrams/./checkout.mmd", "diagrams//checkout.mmd", "./diagrams/checkout.mmd"])(
  "says how to write %s, not that it is outside",
  (path) => {
    expect(publishPathProblem(path)).toBe(
      "Write the path without “./” or “//”, for example diagrams/checkout-flow.mmd.",
    );
  },
);

it.each(["/diagrams/checkout.mmd", "diagrams/../checkout.mmd", "diagrams\\checkout.mmd"])(
  "still refuses %s as outside the folder",
  (path) => {
    expect(publishPathProblem(path)).toBe(
      "Save inside the project’s Archer folder (for example diagrams/checkout-flow.mmd).",
    );
  },
);

it("a path still being typed (diagrams/) asks for the file name, not about ./", () => {
  expect(publishPathProblem("diagrams/")).toBe("The file name must end in .mmd.");
});
