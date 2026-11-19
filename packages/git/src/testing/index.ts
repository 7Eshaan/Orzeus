import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitOid } from "@orzeus/schema";
import { Git } from "../git.js";

/**
 * Creates a repository with one commit containing `files`, using plumbing only.
 * For tests and fixtures; not part of the production API.
 */
export async function createFixtureRepo(
  path: string,
  files: Readonly<Record<string, string>>,
  branch = "main",
): Promise<GitOid> {
  const git = new Git();
  await mkdir(path, { recursive: true });
  await git.run(path, ["init", "--quiet", "-b", branch]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  const listed = Object.keys(files).join("\0");
  await git.run(path, ["update-index", "-z", "--add", "--stdin"], { input: listed });
  const tree = (await git.run(path, ["write-tree"])).trim();
  const commit = await git.commitTree(path, tree, [], "Initial fixture");
  await git.run(path, ["update-ref", `refs/heads/${branch}`, commit]);
  return commit;
}
