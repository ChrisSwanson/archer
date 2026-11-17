import { describe, expect, it } from "vitest";
import { placeDiscussion } from "../src/comments/FloatingDiscussion";

const anchor = { left: 252, top: 404, right: 900, bottom: 430 };
const workspace = { left: 64, top: 104, width: 1376, height: 796 };
const key = { left: 1090, top: 104, right: 1440, bottom: 900 };
const size = { width: 360, height: 312 };

describe("discussion workspace placement", () => {
  it("uses a clear side instead of covering the docked Key", () => {
    const at = placeDiscussion(anchor, size, workspace, [key]);
    expect(at.x + size.width).toBeLessThanOrEqual(key.left);
    expect(at.x).toBeGreaterThanOrEqual(workspace.left + 12);
    expect(at.y).toBeGreaterThanOrEqual(anchor.bottom + 16);
  });
  it("avoids floating chrome within the workspace", () => {
    const at = placeDiscussion({ left: 500, top: 300, right: 600, bottom: 340 }, size, workspace, [
      { left: 610, top: 250, right: 1000, bottom: 700 },
    ]);
    expect(at.x + size.width).toBeLessThanOrEqual(500 - 16);
  });
});

it("constrains a large discussion to the space left beside panels", async () => {
  const { fitDiscussion } = await import("../src/comments/discussion-placement");
  const result = fitDiscussion(anchor, { width: 360, height: 1200 }, { ...workspace, width: 600 }, [
    { left: 500, top: 104, right: 664, bottom: 900 },
  ]);
  expect(result.width).toBe(360);
  expect(result.height).toBe(772);
  expect(result.x).toBeGreaterThanOrEqual(76);
  expect(result.x + result.width).toBeLessThanOrEqual(488);
  expect(result.y + result.height).toBeLessThanOrEqual(888);
});

it("constrains width as well as height in a narrow workspace", async () => {
  const { fitDiscussion } = await import("../src/comments/discussion-placement");
  const result = fitDiscussion(anchor, { width: 360, height: 1200 }, { left: 64, top: 104, width: 320, height: 400 });
  expect(result).toEqual({ x: 76, y: 116, width: 296, height: 376 });
});

it("keeps a sequence discussion beside its participant when the Key leaves a narrower side", async () => {
  const { fitDiscussion } = await import("../src/comments/discussion-placement");
  const participant = { left: 650, right: 770, top: 150, bottom: 190 };
  const result = fitDiscussion(
    participant,
    { width: 360, height: 350 },
    { left: 64, top: 104, width: 1026, height: 696 },
    [],
    { preferSide: true },
  );
  expect(result.x).toBeGreaterThanOrEqual(participant.right + 16);
  expect(result.x + result.width).toBeLessThanOrEqual(1078);
  expect(result.width).toBeGreaterThanOrEqual(240);
});

it("uses the remaining side of the rightmost participant before covering its incoming messages", async () => {
  const { fitDiscussion } = await import("../src/comments/discussion-placement");
  const participant = { left: 717, right: 869, top: 123, bottom: 171 };
  const result = fitDiscussion(
    participant,
    { width: 360, height: 344 },
    { left: 64, top: 102, width: 1026, height: 798 },
    [],
    { preferSide: true },
  );
  expect(result.x).toBeGreaterThan(participant.right);
  expect(result.x + result.width).toBeLessThanOrEqual(1078);
  expect(result.width).toBeGreaterThanOrEqual(180);
});
