import { expect, it } from "vitest";
import { terminalOs } from "../../../site/.vitepress/theme/terminal-os.mts";

const ua = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  chromeos:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

it("reads the platform from client hints first, then the user agent", () => {
  expect(terminalOs({ userAgent: ua.linux, userAgentData: { platform: "macOS" } })).toBe("mac");
  expect(terminalOs({ userAgent: ua.mac, userAgentData: { platform: "Windows" } })).toBe("windows");
  expect(terminalOs({ userAgent: ua.mac, userAgentData: { platform: "Linux" } })).toBe("linux");
  expect(terminalOs({ userAgent: ua.mac, userAgentData: { platform: "Chrome OS" } })).toBe("neutral");
  // An overridden agent without hints reports an empty platform: the string decides.
  expect(terminalOs({ userAgent: ua.windows, userAgentData: { platform: "" } })).toBe("windows");
  expect(terminalOs({ userAgent: ua.mac })).toBe("mac");
  expect(terminalOs({ userAgent: ua.linux })).toBe("linux");
});

it("gives phones, tablets, ChromeOS and the unknown the neutral frame", () => {
  for (const agent of [ua.iphone, ua.android, ua.chromeos, "curl/8.0"])
    expect(terminalOs({ userAgent: agent })).toBe("neutral");
});
