import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspaceSnapshot } from "../src/workspace.ts";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "repro-workspace-"));
  directories.push(root);
  await exec("git", ["init", root]);
  await writeFile(join(root, "source.txt"), "baseline");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "baseline",
  ]);
  return root;
}
describe("workspace fingerprints", () => {
  it("frames binary file contents so moving delimiter bytes across files changes the fingerprint", async () => {
    const root = await repository();
    await writeFile(join(root, "a"), "first");
    await writeFile(join(root, "b"), "last");
    const mode = (await lstat(join(root, "b"))).mode;
    const separator = `\0b\0${mode}`;
    await writeFile(join(root, "a"), `first${separator}middle`);
    const first = await getWorkspaceSnapshot(root);
    await writeFile(join(root, "a"), "first");
    await writeFile(join(root, "b"), `middle${separator}last`);
    expect((await getWorkspaceSnapshot(root)).fingerprint).not.toBe(first.fingerprint);
  });
  it("detects content changes even when Git's assume-unchanged flag hides the diff", async () => {
    const root = await repository();
    const before = await getWorkspaceSnapshot(root);
    await exec("git", ["-C", root, "update-index", "--assume-unchanged", "source.txt"]);
    await writeFile(join(root, "source.txt"), "modified despite the flag");
    expect((await getWorkspaceSnapshot(root)).fingerprint).not.toBe(before.fingerprint);
  });
  it("detects tracked and untracked content changes, including a second edit to the same file", async () => {
    const root = await repository();
    const a = await getWorkspaceSnapshot(root);
    await writeFile(join(root, "source.txt"), "fix");
    const b = await getWorkspaceSnapshot(root);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    await writeFile(join(root, "regression.txt"), "test one");
    const c = await getWorkspaceSnapshot(root);
    await writeFile(join(root, "regression.txt"), "test two");
    expect((await getWorkspaceSnapshot(root)).fingerprint).not.toBe(c.fingerprint);
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("fix");
  });
  it("excludes generated reports and resolves a nested working directory to the repository root", async () => {
    const root = await repository();
    await mkdir(join(root, "nested"));
    const a = await getWorkspaceSnapshot(join(root, "nested"));
    await mkdir(join(root, ".repro-pilot"));
    await writeFile(join(root, ".repro-pilot", "report.md"), "generated");
    const b = await getWorkspaceSnapshot(root);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(a.root).toBe(b.root);
    expect(b.head).toMatch(/^[a-f0-9]{40}$/u);
  });
});
