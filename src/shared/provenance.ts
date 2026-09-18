import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.js";

export const WORKFLOW = "de-seller-library-180d-all-sales7d-na-v2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function codeFingerprint(): string {
  const walk = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  const files = [...walk("src"), "package.json", "pnpm-lock.yaml", "run.ps1"].sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(file).update("\0").update(readFileSync(path.join(root, file))).update("\0");
  return digest.digest("hex");
}
export function effectiveConfigHash(config: AppConfig): string { return hash(JSON.stringify(config)); }
export function runContractHash(config: AppConfig, sourceHash: string, asOfDate: string, fingerprint = codeFingerprint()): string {
  return hash(JSON.stringify({ workflow: WORKFLOW, schema: 19, effectiveConfigHash: effectiveConfigHash(config), sourceHash, asOfDate, fingerprint }));
}
export function releaseInfo(): Record<string, string> {
  const version = String(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
  const git = (...args: string[]): string => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return "unavailable"; } };
  return { version, gitCommit: git("rev-parse", "HEAD"), gitTag: git("describe", "--tags", "--exact-match", "HEAD"), gitDirty: String(git("status", "--porcelain") !== ""), node: process.version };
}
