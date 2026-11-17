// node --test tools/devkit/test/other-account-socket.test.mjs
// The another-account socket probe (tools/devkit/security/other-account-socket.mjs), when Docker can run
// it here: a private socket directory refuses another uid (EACCES) and admits the owner's; seeded, a
// socket in a world-open directory is reached by the other uid and the probe reports the failure.
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerProblem, localNodeImage, probe } from "../security/other-account-socket.mjs";

const problem = dockerProblem() ?? (localNodeImage() === undefined ? "no local image with node" : undefined);
const skip = problem === undefined ? false : `docker cannot run the probe here: ${problem}`;

test("another uid is refused by a private socket directory; the owner connects", {
  skip,
  timeout: 180_000,
}, async () => {
  const result = await probe();
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.deepEqual([result.other.connected, result.other.code], [false, "EACCES"]);
  assert.deepEqual([result.owner.connected, result.owner.answered], [true, true]);
});

test("seeded: a socket in a world-open directory is reached by another uid, and the probe fails", {
  skip,
  timeout: 180_000,
}, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "archer-r4-open-")));
  const socket = join(dir, "open.sock");
  const server = createServer((connection) => connection.once("data", () => connection.end('{"id":1,"ok":true}\n')));
  await new Promise((resolve) => server.listen(socket, resolve));
  chmodSync(dir, 0o777);
  chmodSync(socket, 0o777);
  try {
    const result = await probe({ socket });
    assert.equal(result.status, 1);
    assert.equal(result.other.connected, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
