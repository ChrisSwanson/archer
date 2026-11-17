// `archer network-access` at a terminal: the person answers the question themselves.
import { createInterface } from "node:readline/promises";

export async function askAtTerminal(question: string): Promise<"yes" | "no"> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim()) ? "yes" : "no";
  } finally {
    prompt.close();
  }
}
