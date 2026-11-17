import { describe, expect, test } from "vitest";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { ProjectError } from "../../src/project/errors.ts";

function refusal(text: string): ProjectError {
  try {
    parseGlobalConfig(text);
  } catch (error) {
    if (error instanceof ProjectError) return error;
    throw error;
  }
  throw new Error("expected configuration to be refused");
}

describe("parseGlobalConfig", () => {
  test("parses the complete two-place global schema through production code", () => {
    expect(
      parseGlobalConfig(`
version = 1
[service]
name = "default-lan"
host = "archer.example.test"
port = 4400
admission = "listed"
public_url = "HTTPS://Archer.Example.Test/"
open_browser = "always"
auto_start = false
restore = true
comment_submission = "immediate"
[[services]]
name = "courierdesk"
host = "127.0.0.1"
port = 4401
admission = "any"
open_browser = "never"
auto_start = true
restore = false
comment_submission = "queued"
[[projects]]
path = "/home/me/code/**"
service = "courierdesk"
read_only = true
admit = false
diagrams = true
notes = false
comments = true
emphasis = false
register = true
manifest = false
`),
    ).toEqual({
      version: 1,
      service: {
        name: "default-lan",
        host: "archer.example.test",
        port: 4400,
        admission: "listed",
        publicUrl: "https://archer.example.test:443",
        openBrowser: "always",
        autoStart: false,
        restore: true,
        commentSubmission: "immediate",
      },
      services: [
        {
          name: "courierdesk",
          host: "127.0.0.1",
          port: 4401,
          admission: "any",
          openBrowser: "never",
          autoStart: true,
          restore: false,
          commentSubmission: "queued",
        },
      ],
      projects: [
        {
          path: "/home/me/code/**",
          service: "courierdesk",
          readOnly: true,
          admit: false,
          diagrams: true,
          notes: false,
          comments: true,
          emphasis: false,
          register: true,
          manifest: false,
        },
      ],
    });
  });

  test("parses a minimal configuration without filling optional settings", () => {
    expect(parseGlobalConfig("version = 1\n")).toEqual({ version: 1 });
  });

  test.each(["name", "folder", "views", "state", "socket", "unknown"])(
    "refuses the unknown or project-only top-level key %s",
    (key) => {
      const error = refusal(`version = 1\n${key} = "x"\n`);
      expect(error.code).toBe("manifest_error");
      expect(error.message).toContain(key);
    },
  );

  test.each([
    ["missing version", "", /version/],
    ["wrong version", "version = 2", /version/],
    ["service as a value", 'version = 1\nservice = "x"', /service/],
    ["services as a value", 'version = 1\nservices = "x"', /services/],
    ["projects as a value", 'version = 1\nprojects = "x"', /projects/],
    ["unknown service key", 'version = 1\n[service]\nsocket = "x"', /socket/],
    ["named service without a name", 'version = 1\n[[services]]\nhost = "localhost"', /name/],
    [
      "duplicate named services",
      'version = 1\n[[services]]\nname = "one"\n[[services]]\nname = "one"',
      /more than once/,
    ],
    ["unknown project key", 'version = 1\n[[projects]]\npath = "/x"\nfolder = "x"', /folder/],
    ["project without a path", "version = 1\n[[projects]]\nadmit = true", /path/],
    ["relative project path", 'version = 1\n[[projects]]\npath = "project"', /absolute/],
  ])("refuses %s", (_, text, message) => {
    const error = refusal(text);
    expect(error.code).toBe("manifest_error");
    expect(error.message).toMatch(message);
  });

  test.each([
    ["name", "Courier", /match/],
    ["host", "http://localhost", /host/],
    ["port", 1023, /1024/],
    ["port", 65536, /65535/],
    ["admission", "sometimes", /admission/],
    ["open_browser", "sometimes", /open_browser/],
    ["auto_start", "true", /true or false/],
    ["restore", 1, /true or false/],
    ["comment_submission", "later", /queued.*immediate/],
    ["public_url", "https://user@example.test/", /credentials/],
    ["public_url", "https://example.test/path", /path/],
    ["public_url", "https://example.test/?q=1", /query/],
    ["public_url", "https://example.test/?", /query/],
    ["public_url", "https://example.test/#", /fragment/],
    ["public_url", "https://example.test/a/../", /path/],
    ["public_url", "http:example.test", /absolute HTTP/],
    ["public_url", "https:example.test", /absolute HTTP/],
    ["public_url", "https:\\example.test", /absolute HTTP/],
    ["public_url", "https://@example.test/", /credentials/],
  ])("refuses invalid service %s = %j", (key, value, message) => {
    const encoded = typeof value === "string" ? JSON.stringify(value) : String(value);
    expect(refusal(`version = 1\n[service]\n${key} = ${encoded}\n`).message).toMatch(message);
  });

  test.each(["127.0.0.1", "::1", "archer.example.test", "localhost"])("accepts service host %s", (host) => {
    expect(parseGlobalConfig(`version = 1\n[service]\nhost = ${JSON.stringify(host)}\n`).service?.host).toBe(host);
  });

  test.each(["auto", "always", "never"] as const)("accepts open_browser = %s", (mode) => {
    expect(
      parseGlobalConfig(`version = 1\n[service]\nopen_browser = ${JSON.stringify(mode)}\n`).service?.openBrowser,
    ).toBe(mode);
  });

  test("normalizes public_url with an explicit effective port", () => {
    expect(parseGlobalConfig('version = 1\n[service]\npublic_url = "http://LOCALHOST/"\n').service?.publicUrl).toBe(
      "http://localhost:80",
    );
    expect(
      parseGlobalConfig('version = 1\n[service]\npublic_url = "https://example.test:444/"\n').service?.publicUrl,
    ).toBe("https://example.test:444");
  });

  test.each(["/home/me/../other/**", "/home//me/**", "/home/me/./**", "/home/me\n/**", "C:\\projects\\**"])(
    "refuses a non-canonical project path %j",
    (path) =>
      expect(() => parseGlobalConfig(`version = 1\n[[projects]]\npath = ${JSON.stringify(path)}\n`)).toThrow(
        /canonical absolute path/,
      ),
  );
});

describe("pairing_code_minutes", () => {
  test.each([1, 5, 60])("accepts %d minutes, under [service] and [[services]]", (minutes) => {
    expect(
      parseGlobalConfig(`version = 1\n[service]\npairing_code_minutes = ${minutes}\n`).service?.pairingCodeMinutes,
    ).toBe(minutes);
    expect(
      parseGlobalConfig(`version = 1\n[[services]]\nname = "lan"\npairing_code_minutes = ${minutes}\n`).services?.[0]
        ?.pairingCodeMinutes,
    ).toBe(minutes);
  });
  test("refuses a fractional pairing_code_minutes", () => {
    expect(refusal("version = 1\n[service]\npairing_code_minutes = 2.5\n").code).toBe("manifest_error");
  });
  test.each(["0", "61", "-5", '"5"', "true"])("refuses pairing_code_minutes = %s with the bounds", (value) => {
    expect(refusal(`version = 1\n[service]\npairing_code_minutes = ${value}\n`).message).toMatch(
      /pairing_code_minutes.*1 through 60/,
    );
  });
});
