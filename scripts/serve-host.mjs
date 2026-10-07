import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lan = process.argv.includes("--lan");
const child = spawn(process.execPath, [path.join(root, "apps/bridge/dist/server.cjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: lan ? "0.0.0.0" : process.env.HOST || "127.0.0.1",
    MOBILEAGENT_STATIC: path.join(root, "apps/web/dist"),
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
