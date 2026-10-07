import path from "node:path";
import { HubError } from "./errors";

export function resolveInside(root: string, rel: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, rel || ".");
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new HubError("path escapes workspace", 400, "path");
  }
  return target;
}
