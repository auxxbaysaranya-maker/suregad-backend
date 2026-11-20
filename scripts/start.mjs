// Production entry point: node scripts/start.mjs
// Trusts the operating system's CA certificates when this Node version supports
// --use-system-ca (Node 22.15+ / 23.8+); older runtimes (e.g. Node 20 hosts) start without it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/server.cjs");
const flags = process.allowedNodeEnvironmentFlags.has("--use-system-ca") ? ["--use-system-ca"] : [];

const child = spawn(process.execPath, [...flags, entry], { stdio: "inherit", env: process.env });

// Let the platform's stop signals reach the server so it shuts down cleanly.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
