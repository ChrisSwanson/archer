// The delivery order and automatic launch (ADR 0035, amended 2026-10-31): set in the person's own
// archer.toml `[agents]`, per project in its `[[projects]]` rules; a project's own archer.toml may only
// narrow it. Unknown values are a config error naming the setting.
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_DELIVERY_POLICY, deliveryPolicy } from "../../src/config/agents.ts";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { findProject } from "../../src/project/index.ts";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(async () => {
  await cleanUp();
});

const account = (agents: string, projects = "") => parseGlobalConfig(`version = 1\n[agents]\n${agents}\n${projects}`);
const local = (agents: string) => {
  const root = tempDir();
  write(root, "archer.toml", `version = 1\n[agents]\n${agents}\n`);
  return findProject(root);
};

describe("the account's [agents]", () => {
  test("defaults: the full order, 2 minutes, the owner only; launch is auto once a launcher is set (D9), else nothing launches", () => {
    expect(DEFAULT_DELIVERY_POLICY).toEqual({
      order: ["listener", "next_turn", "launch"],
      nextTurnWaitMs: 120_000,
      launch: "ask",
      launchFor: "owner",
    });
    expect(deliveryPolicy({ version: 1 }, undefined, "/code/app")).toEqual(DEFAULT_DELIVERY_POLICY);
    expect(deliveryPolicy(account('launcher = ["claude", "-p"]'), undefined, "/code/app")).toEqual({
      ...DEFAULT_DELIVERY_POLICY,
      launch: "auto",
    });
    // "ask" and "off" still work, in [agents] or a [[projects]] rule; a project's own file still narrows it.
    expect(deliveryPolicy(account('launcher = ["claude"]\nlaunch = "ask"'), undefined, "/code/app")).toMatchObject({
      launch: "ask",
    });
    expect(
      deliveryPolicy(
        account('launcher = ["claude"]', '[[projects]]\npath = "/code/app"\nlaunch = "off"\n'),
        undefined,
        "/code/app",
      ),
    ).toMatchObject({ launch: "off" });
    expect(deliveryPolicy(account('launcher = ["claude"]'), local('launch = "ask"'), "/code/app")).toMatchObject({
      launch: "ask",
    });
  });

  test("the four settings parse, and a [[projects]] rule overrides each for its project", () => {
    const config = account(
      'launcher = ["claude", "-p"]\ndelivery = ["listener", "next_turn", "launch"]\nnext_turn_wait = "90s"\nlaunch = "auto"\nlaunch_for = "anyone"',
      '[[projects]]\npath = "/code/app"\ndelivery = ["listener", "launch"]\nnext_turn_wait = "5m"\nlaunch = "ask"\nlaunch_for = "owner"\n',
    );
    expect(config.agents).toEqual({
      launcher: ["claude", "-p"],
      delivery: ["listener", "next_turn", "launch"],
      nextTurnWaitMs: 90_000,
      launch: "auto",
      launchFor: "anyone",
    });
    expect(deliveryPolicy(config, undefined, "/code/other")).toEqual({
      order: ["listener", "next_turn", "launch"],
      nextTurnWaitMs: 90_000,
      launch: "auto",
      launchFor: "anyone",
    });
    expect(deliveryPolicy(config, undefined, "/code/app")).toEqual({
      order: ["listener", "launch"],
      nextTurnWaitMs: 300_000,
      launch: "ask",
      launchFor: "owner",
    });
  });

  test("leaving launch out of the order turns launching off", () => {
    const config = account('launcher = ["claude"]\nlaunch = "auto"\ndelivery = ["listener", "next_turn"]');
    expect(deliveryPolicy(config, undefined, "/code/app")).toMatchObject({
      order: ["listener", "next_turn"],
      launch: "off",
    });
  });

  test.each([
    ['delivery = ["listener", "telepathy"]', /delivery/],
    ['delivery = ["next_turn", "launch"]', /delivery.*listener/],
    ['delivery = ["listener", "launch", "next_turn"]', /delivery.*order/],
    ['delivery = ["listener", "listener"]', /delivery/],
    ["delivery = []", /delivery/],
    ['delivery = "listener"', /delivery/],
    ['next_turn_wait = "2h"', /next_turn_wait/],
    ['next_turn_wait = "31m"', /next_turn_wait/],
    ["next_turn_wait = 120", /next_turn_wait/],
    ['next_turn_wait = "-1s"', /next_turn_wait/],
    ['launch = "always"', /launch/],
    ["launch = true", /launch/],
    ['launch_for = "everyone"', /launch_for/],
    ['launch = "auto"', /launch = "auto".*launcher/],
  ])("%s is refused with a config error naming it", (line, why) => {
    expect(() => account(line)).toThrow(/global archer\.toml cannot be used/);
    expect(() => account(line)).toThrow(why);
  });

  test("auto in a [[projects]] rule needs the account's launcher too; unknown rule values are refused", () => {
    expect(() => account("", '[[projects]]\npath = "/code/app"\nlaunch = "auto"\n')).toThrow(
      /launch = "auto".*launcher/,
    );
    expect(() => account('launcher = ["claude"]', '[[projects]]\npath = "/code/app"\nlaunch_for = "nobody"\n')).toThrow(
      /launch_for/,
    );
    expect(() => account('launcher = ["claude"]', '[[projects]]\npath = "/code/app"\nlaunch = "auto"\n')).not.toThrow();
  });
});

describe("a project's own archer.toml", () => {
  const auto = () => account('launcher = ["claude"]\nlaunch = "auto"\nlaunch_for = "anyone"\nnext_turn_wait = "1m"');

  test("narrows: launch off or ask, launch_for owner, steps dropped from the person's order", () => {
    expect(deliveryPolicy(auto(), local('launch = "off"'), "/code/app")).toMatchObject({ launch: "off" });
    expect(deliveryPolicy(auto(), local('launch = "ask"'), "/code/app")).toMatchObject({ launch: "ask" });
    expect(deliveryPolicy(auto(), local('launch_for = "owner"'), "/code/app")).toMatchObject({
      launch: "auto",
      launchFor: "owner",
    });
    expect(deliveryPolicy(auto(), local('delivery = ["listener", "next_turn"]'), "/code/app")).toMatchObject({
      order: ["listener", "next_turn"],
      launch: "off",
    });
    expect(deliveryPolicy(auto(), local('delivery = ["listener"]'), "/code/app")).toMatchObject({
      order: ["listener"],
      launch: "off",
    });
  });

  test("C-33: next_turn may be left out only with launch: without the wait an agent would be launched sooner", () => {
    expect(() => local('delivery = ["listener", "launch"]')).toThrow(
      /\[agents\] `delivery` may leave out "next_turn" only together with "launch"/u,
    );
    // The person's own file may still skip the wait.
    expect(
      deliveryPolicy(account('launcher = ["claude"]\ndelivery = ["listener", "launch"]'), undefined, "/code/app"),
    ).toMatchObject({ order: ["listener", "launch"], launch: "auto" });
  });

  const views =
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n';
  const placed = (text: string) => {
    const root = tempDir();
    write(root, ".archer/flow.mmd", "flowchart LR\n  a --> b\n");
    write(root, "archer.toml", text);
    return findProject(root);
  };

  test.each(['launch = "off"', 'launch = "ask"', 'launch_for = "owner"'])(
    "C-33/X-19: %s written under [[views]] is that view's problem naming its line, and automatic launch is off",
    (line) => {
      const project = placed(`${views}${line}\n`);
      const key = line.split(" ")[0]!;
      expect(project.problems).toEqual([
        expect.objectContaining({
          position: 1,
          id: "flow",
          message: expect.stringMatching(
            new RegExp(
              `^line 8: \`${key}\` is under the \\[\\[views\\]\\] header on line 3, .*move it under \\[agents\\].*automatic launch is off for this project`,
              "u",
            ),
          ),
        }),
      ]);
      expect(deliveryPolicy(auto(), project, "/code/app")).toMatchObject({ launch: "ask" });
    },
  );

  test("C-33/X-19: a delivery key under another table refuses the manifest naming the line; under [agents] it is read", () => {
    // A list under [[views]] is already a parse error with its line: nothing loads, nothing launches.
    expect(() => placed(`${views}delivery = ["listener"]\n`)).toThrow(/line 8/u);
    expect(() => placed('version = 1\n[discovery]\nlaunch = "off"\n')).toThrow(
      /line 3: `launch` is under the \[discovery\] header on line 2, .*\[agents\]/u,
    );
    expect(placed('version = 1\n[agents]\nlaunch = "off"\n').problems).toEqual([]);
    // [feedback] has a `delivery` of its own.
    expect(placed('version = 1\n[feedback]\ndelivery = "next_call"\n').problems).toEqual([]);
  });

  test("C-33/X-19: an account delivery key under another table is refused naming the line; [agents] and [[projects]] read it", () => {
    expect(() => parseGlobalConfig('version = 1\n[service]\nport = 4000\nlaunch = "off"\n')).toThrow(
      /line 4: `launch` is under the \[service\] header on line 2, .*\[agents\]/u,
    );
    expect(() =>
      parseGlobalConfig(
        'version = 1\n[agents]\nlauncher = ["claude"]\n[[projects]]\npath = "/code/app"\nlaunch = "off"\n',
      ),
    ).not.toThrow();
  });

  test("never widens: a narrower account setting wins over the project's", () => {
    const ask = account('launcher = ["claude"]\ndelivery = ["listener", "launch"]');
    expect(
      deliveryPolicy(
        ask,
        local('launch = "ask"\nlaunch_for = "owner"\ndelivery = ["listener", "next_turn", "launch"]'),
        "/code/app",
      ),
    ).toEqual({ order: ["listener", "launch"], nextTurnWaitMs: 120_000, launch: "ask", launchFor: "owner" });
    const off = account('launcher = ["claude"]\nlaunch = "off"');
    expect(deliveryPolicy(off, local('launch = "ask"'), "/code/app")).toMatchObject({ launch: "off" });
  });

  test.each([
    ['launcher = ["sh", "-c", "touch owned"]', /launcher.*~\/\.config\/archer\/archer\.toml/],
    ['launch = "auto"', /launch = "auto".*~\/\.config\/archer\/archer\.toml/],
    ['launch_for = "anyone"', /launch_for = "anyone".*~\/\.config\/archer\/archer\.toml/],
    ['next_turn_wait = "1s"', /next_turn_wait.*~\/\.config\/archer\/archer\.toml/],
    ['launch_cwd = "/"', /unknown \[agents\] setting "launch_cwd"/],
    ['delivery = ["launch"]', /delivery.*listener/],
    ['launch = "sometimes"', /launch/],
  ])("%s is refused: a cloned repository cannot make Archer run commands", (line, why) => {
    expect(() => local(line)).toThrow(why);
  });
});
