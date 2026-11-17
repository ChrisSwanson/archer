/**
 * The two one-line installs the landing offers, verbatim (the release asset and install.sh ship with the docs site).
 * npm is not published yet, so npx takes the release tarball. install.sh is POSIX sh (shellcheck -s sh), so `| sh`.
 * `shown` is the command in three parts: the terminal draws the middle (the long address) as "…/", and the page
 * still holds all of it, so selecting, copying and reading it out give the whole command.
 */
export const installCommands = [
  {
    id: "npx",
    label: "npx",
    command: "npx -y https://github.com/chrisswanson/archer/releases/latest/download/archer.tgz setup",
    shown: ["npx -y ", "https://github.com/chrisswanson/archer/releases/latest/download/", "archer.tgz setup"],
    note: "Downloads the release from GitHub Releases and runs setup.",
  },
  {
    id: "curl",
    label: "curl",
    command: "curl -fsSL https://chrisswanson.github.io/archer/install.sh | sh",
    shown: ["curl -fsSL ", "https://chrisswanson.github.io/archer/", "install.sh | sh"],
    note: "Checks Node, downloads the release, verifies its SHA-256 checksum and runs setup.",
  },
] as const;

export type InstallMethod = (typeof installCommands)[number]["id"];
