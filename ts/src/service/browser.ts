// Browser launching is a service policy, shared by every front door. Recovery
// never calls it, and an undetected/headless session stays quiet by default.
import { spawn } from "node:child_process";
import type { Env } from "./paths.ts";

export function shouldOpenBrowser(env: Env, platform: NodeJS.Platform = process.platform): boolean {
  const policy = env["ARCHER_OPEN_BROWSER"] ?? "auto";
  if (!["auto", "always", "never"].includes(policy))
    throw new Error("ARCHER_OPEN_BROWSER must be auto, always or never");
  if (policy !== "auto") return policy === "always";
  if ((env["CI"] && env["CI"] !== "false" && env["CI"] !== "0") || env["SSH_CONNECTION"] || env["SSH_TTY"])
    return false;
  if (platform === "linux") return Boolean(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
  if (platform === "darwin") return Boolean(env["TERM_PROGRAM"] || env["DISPLAY"]);
  if (platform === "win32") return Boolean(env["SESSIONNAME"] && env["SESSIONNAME"] !== "Services");
  return false;
}

/** Resolves when the opener starts, not a claim that a particular browser rendered. */
export async function launchBrowser(url: string, command?: readonly string[]): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("browser URL must use HTTP or HTTPS");
  const [program, ...args] =
    command ??
    (process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
        : ["xdg-open"]);
  if (!program) throw new Error("browser opener command is empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, [...args, url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
