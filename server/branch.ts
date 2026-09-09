import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Wait for a worktree's branch to no longer be checked out, then delete it. */
export async function deleteBranchAfterWorktreeGone(
  branch: string,
  mainRepoRoot: string,
  workspaceId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    // `git branch -D` fails while the branch is checked out in a worktree.
    // Retry until the daemon's archive flow removes the worktree.
    try {
      const { stderr } = await execFileAsync(
        "git",
        ["branch", "-D", branch],
        { cwd: mainRepoRoot, timeout: 10_000 },
      );
      if (stderr) {
        console.log(`[archive-branch-cleanup] git stderr for ${branch}: ${stderr.trim()}`);
      }
      console.log(
        `[archive-branch-cleanup] Deleted branch "${branch}" in ${mainRepoRoot} for workspace ${workspaceId}`,
      );
      // Prune remote-tracking refs so branch suggestions in Paseo reflect
      // branches that were deleted on the remote (e.g. merged PR heads).
      try {
        await execFileAsync("git", ["fetch", "--prune", "origin"], {
          cwd: mainRepoRoot,
          timeout: 120_000,
        });
        console.log(`[archive-branch-cleanup] Pruned remote refs in ${mainRepoRoot}`);
      } catch (error) {
        // Network failure is not fatal; local branch deletion already succeeded.
        console.warn(`[archive-branch-cleanup] git fetch --prune failed in ${mainRepoRoot}`, error);
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.error(
    `[archive-branch-cleanup] Timed out deleting branch "${branch}" for workspace ${workspaceId}`,
    lastError,
  );
}
