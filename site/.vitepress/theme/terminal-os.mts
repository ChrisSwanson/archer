/** Which terminal the install block draws: the reader's own, or a neutral one when it cannot tell (or before script). */
export type TerminalOs = "mac" | "linux" | "windows" | "neutral";

interface UaData {
  readonly platform?: string;
}

/**
 * From the browser's client hints when it gives a platform (`navigator.userAgentData.platform`), else the user agent
 * string. Phones and tablets (iOS, Android) and ChromeOS get the neutral frame: they are not where Archer runs.
 */
export function terminalOs(nav: {
  readonly userAgent: string;
  readonly userAgentData?: UaData | undefined;
}): TerminalOs {
  const platform = nav.userAgentData?.platform?.trim() ?? "";
  if (platform !== "") {
    if (platform === "macOS") return "mac";
    if (platform === "Windows") return "windows";
    if (platform === "Linux") return "linux";
    return "neutral";
  }
  const agent = nav.userAgent;
  if (/iPhone|iPad|iPod|Android|CrOS/u.test(agent)) return "neutral";
  if (/Macintosh|Mac OS X/u.test(agent)) return "mac";
  if (/Windows NT/u.test(agent)) return "windows";
  if (/Linux|X11/u.test(agent)) return "linux";
  return "neutral";
}
