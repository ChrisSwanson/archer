// The development entry the front doors start under tsx, until `archer serve
// --foreground` is wired into the command line: `node --import tsx entry.ts`.
import { main } from "../bin/main.ts";

const args = process.argv.slice(2);
process.exitCode = await main(args.length === 0 ? ["serve", "--foreground"] : args, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  isTTY: false,
  columns: undefined,
});
