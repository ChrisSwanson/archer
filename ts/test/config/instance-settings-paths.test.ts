// The page's account settings name no absolute path (server review S13): the config file and the
// TLS certificate are shown home-relative, as project settings show a project's location.

import { expect, test } from "vitest";
import { InstanceSettingsStore } from "../../src/config/instance-settings.ts";

test("the config path and the TLS certificate are home-relative; the key is only 'set'", () => {
  const home = "/srv/people/alice";
  const store = new InstanceSettingsStore(
    "default",
    { HOME: home, XDG_CONFIG_HOME: `${home}/.config` },
    "/nonexistent/archer.toml",
    undefined,
    { tlsCert: `${home}/tls/cert.pem`, tlsKey: `${home}/tls/key.pem` },
  );
  const read = store.read();
  expect(read.configPath).toBe("~/.config/archer/archer.toml");
  expect(read.settings.find((s) => s.key === "tlsCert")?.value).toBe("~/tls/cert.pem");
  expect(read.settings.find((s) => s.key === "tlsKey")?.value).toBe("set");
  expect(JSON.stringify(read)).not.toContain(home);
});
