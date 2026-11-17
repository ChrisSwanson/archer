import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CONFIG_FILE_SYSTEM,
  readGlobalConfig,
  readGlobalConfigSnapshotWithFileSystem,
  readGlobalConfigWithFileSystem,
} from "../../src/config/index.ts";
import { ProjectError } from "../../src/project/errors.ts";
import { MAX_MANIFEST_BYTES } from "../../src/project/project.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

function failure(run: () => unknown): ProjectError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

test("reads a regular trusted user configuration", () => {
  const dir = tempDir({ "archer.toml": 'version = 1\n[service]\nhost = "localhost"\n' });
  chmodSync(join(dir, "archer.toml"), 0o600);
  expect(readGlobalConfig(join(dir, "archer.toml"), { principal: "user" }).service?.host).toBe("localhost");
});

test("returns exact source and parsed config from one trusted bounded descriptor snapshot", () => {
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  const path = join(dir, "archer.toml");
  chmodSync(path, 0o600);
  const source = 'version = 1\n# retained\n[service]\ncomment_submission = "immediate"\n';
  let offset = 0;
  const snapshot = readGlobalConfigSnapshotWithFileSystem(
    path,
    { principal: "user" },
    {
      ...CONFIG_FILE_SYSTEM,
      readSync: (_fd, buffer, at, length) => {
        const bytes = Buffer.from(source, "utf8");
        const count = Math.min(length, bytes.length - offset);
        if (count <= 0) return 0;
        bytes.copy(buffer, at, offset, offset + count);
        offset += count;
        return count;
      },
    },
  );
  expect(snapshot.source).toBe(source);
  expect(snapshot.config.service?.commentSubmission).toBe("immediate");
  expect(snapshot.file).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number), mode: expect.any(Number) });
});

test("an optional missing file is empty; a required one is a named configuration failure", () => {
  const path = join(tempDir(), "missing.toml");
  expect(readGlobalConfig(path, { principal: "user" })).toEqual({ version: 1 });
  const error = failure(() => readGlobalConfig(path, { principal: "user", required: true }));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toContain(path);
});

test.each(["symlink", "directory", "other-writable"])("refuses an unsafe %s as untrusted_manifest", (kind) => {
  const dir = tempDir({ "real.toml": "version = 1\n" });
  const path = join(dir, "archer.toml");
  if (kind === "symlink") symlinkSync(join(dir, "real.toml"), path);
  else if (kind === "directory") mkdirSync(path);
  else {
    writeFileSync(path, "version = 1\n");
    chmodSync(path, 0o602);
  }
  const error = failure(() => readGlobalConfig(path, { principal: "user" }));
  expect(error.code).toBe("untrusted_manifest");
  expect(error.message).toContain(path);
});

// X-18 (re-score 2): the account file is read only when it has one name, as the project manifest is.
// A hard link is another name for a file that may live, and be changed, somewhere else.
test("refuses a hard-linked account archer.toml with a named diagnostic; one name is read", () => {
  const outside = tempDir({ "elsewhere.toml": 'version = 1\n[agents]\nlauncher = ["sh"]\n' });
  chmodSync(join(outside, "elsewhere.toml"), 0o600);
  const dir = tempDir();
  const path = join(dir, "archer.toml");
  linkSync(join(outside, "elsewhere.toml"), path);
  const error = failure(() => readGlobalConfig(path, { principal: "user" }));
  expect(error.code).toBe("untrusted_manifest");
  expect(error.message).toBe(
    `${path} has 2 names (a hard link); Archer reads its settings only from a file with one name: make it a plain copy: cp ${path} ${path}.copy && mv ${path}.copy ${path}`,
  );
  writeFileSync(join(dir, "one.toml"), 'version = 1\n[agents]\nlauncher = ["sh"]\n', { mode: 0o600 });
  expect(readGlobalConfig(join(dir, "one.toml"), { principal: "user" }).agents?.launcher).toEqual(["sh"]);
});

test.runIf(process.getuid?.() !== 0)("system configuration must be root-owned", () => {
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  chmodSync(join(dir, "archer.toml"), 0o600);
  expect(failure(() => readGlobalConfig(join(dir, "archer.toml"), { principal: "system" })).code).toBe(
    "untrusted_manifest",
  );
});

test("refuses oversized and invalid UTF-8 files without parsing them", () => {
  const dir = tempDir();
  const large = join(dir, "large.toml");
  const invalid = join(dir, "invalid.toml");
  writeFileSync(large, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20), { mode: 0o600 });
  writeFileSync(invalid, Buffer.from([0xff]), { mode: 0o600 });
  for (const path of [large, invalid]) {
    const error = failure(() => readGlobalConfig(path, { principal: "user" }));
    expect(error.code).toBe("manifest_error");
  }
});

test.runIf(process.platform === "linux")(
  "converts an unexpected real filesystem read failure to manifest_error",
  () => {
    const error = failure(() => readGlobalConfig("/proc/self/mem", { principal: "user", required: true }));
    expect(error.code).toBe("manifest_error");
    expect(error.message).toContain("/proc/self/mem");
  },
);

test("refuses a file when the current owner cannot be verified", () => {
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  chmodSync(join(dir, "archer.toml"), 0o600);
  const getuid = process.getuid;
  try {
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    expect(failure(() => readGlobalConfig(join(dir, "archer.toml"), { principal: "user" })).code).toBe(
      "untrusted_manifest",
    );
  } finally {
    Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
  }
});

test.each(["fstat", "read"])("converts an unexpected %s failure to a path-named manifest_error", (operation) => {
  const dir = tempDir({ "archer.toml": "version = 1\n" });
  const path = join(dir, "archer.toml");
  chmodSync(path, 0o600);
  const failureFromOs = Object.assign(new Error("device failed"), { code: "EIO" });
  let closes = 0;
  const fileSystem = {
    ...CONFIG_FILE_SYSTEM,
    closeSync: (fd: number) => {
      closes++;
      CONFIG_FILE_SYSTEM.closeSync(fd);
    },
    ...(operation === "fstat"
      ? {
          fstatSync: () => {
            throw failureFromOs;
          },
        }
      : {
          readSync: () => {
            throw failureFromOs;
          },
        }),
  };
  const error = failure(() => readGlobalConfigWithFileSystem(path, { principal: "user" }, fileSystem));
  expect(error.code).toBe("manifest_error");
  expect(error.message).toContain(path);
  expect(error.message).toContain("EIO");
  expect(closes).toBe(1);
});

test("a close failure is named but cannot mask an earlier ProjectError", () => {
  const dir = tempDir();
  const valid = join(dir, "valid.toml");
  const invalid = join(dir, "invalid.toml");
  writeFileSync(valid, "version = 1\n", { mode: 0o600 });
  writeFileSync(invalid, Buffer.from([0xff]), { mode: 0o600 });
  const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });
  const fileSystem = {
    ...CONFIG_FILE_SYSTEM,
    closeSync: (fd: number) => {
      CONFIG_FILE_SYSTEM.closeSync(fd);
      throw closeFailure;
    },
  };
  const closeError = failure(() => readGlobalConfigWithFileSystem(valid, { principal: "user" }, fileSystem));
  expect(closeError.code).toBe("manifest_error");
  expect(closeError.message).toMatch(/cannot be closed.*EIO/);
  const parseError = failure(() => readGlobalConfigWithFileSystem(invalid, { principal: "user" }, fileSystem));
  expect(parseError.code).toBe("manifest_error");
  expect(parseError.message).toMatch(/not UTF-8/);
});
