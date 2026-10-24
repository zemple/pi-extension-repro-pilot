import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSnapshot } from "./core/run-state.ts";

const exec = promisify(execFile);
const paths = ["--", ".", ":(exclude).repro-pilot/**"];
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}
export async function getWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  const root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const files = await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    ...paths,
  ]);
  const hash = createHash("sha256").update(JSON.stringify({ head }));
  for (const path of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    const absolute = join(root, path);
    try {
      const info = await lstat(absolute);
      let type: "symlink" | "file";
      let payload: string | Buffer;
      if (info.isSymbolicLink()) {
        type = "symlink";
        payload = await readlink(absolute);
      } else if (info.isFile()) {
        type = "file";
        payload = await readFile(absolute);
      } else throw new Error(`Cannot fingerprint a submodule or special file: ${path}`);
      const digest = createHash("sha256").update(payload).digest("hex");
      hash.update(JSON.stringify({ path, mode: info.mode, type, digest }));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        hash.update(JSON.stringify({ path, type: "deleted" }));
      else throw error;
    }
  }
  return { root, head, fingerprint: hash.digest("hex") };
}
