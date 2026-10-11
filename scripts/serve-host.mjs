import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Legacy MOBILEAGENT_* variables still work.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("MOBILEAGENT_") && process.env["POCKETPILOT_" + key.slice(12)] === undefined) process.env["POCKETPILOT_" + key.slice(12)] = value;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lan = process.argv.includes("--lan");
const child = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: lan ? "0.0.0.0" : process.env.HOST || "127.0.0.1",
    POCKETPILOT_STATIC: path.join(root, "apps/web/dist"),
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
