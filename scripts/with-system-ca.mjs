// Runs a Node entry point with the operating system's CA certificates trusted
// (needed on machines behind corporate TLS inspection when connecting to MongoDB Atlas).
//
// Usage: node scripts/with-system-ca.mjs <script.mjs | tsx> [args...]
// The name "tsx" is resolved to tsx's CLI wherever npm installed it
// (this package's node_modules, or a parent workspace's).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const flag = "--use-system-ca";
const current = process.env.NODE_OPTIONS || "";
// Older Node versions (e.g. 20) don't have the flag; run without it there.
if (process.allowedNodeEnvironmentFlags.has(flag) && !current.split(/\s+/).includes(flag)) {
  process.env.NODE_OPTIONS = `${current} ${flag}`.trim();
}

const args = process.argv.slice(2);
if (args[0] === "tsx") {
  args[0] = createRequire(import.meta.url).resolve("tsx/cli");
}

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
