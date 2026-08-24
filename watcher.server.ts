import { createPaseoClient } from "@getpaseo/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DAEMON_URL = "ws://127.0.0.1:6769/ws";
const STOP_KEY = "__archive_branch_cleanup_stop__";

/** Wait for a worktree's branch to no longer be checked out, then delete it. */
async function deleteBranchAfterWorktreeGone(
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

/** Branch names that must never be deleted, even on a Paseo-owned worktree.
 * Covers common main-line branches. A Paseo worktree can check out an existing
 * branch (e.g. opening a worktree on `main`), so `isPaseoOwnedWorktree` alone
 * is not enough to keep the main branch safe. */
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop", "dev", "production", "prod"]);

function isProtectedBranch(branch: string): boolean {
  const name = branch.trim();
  if (PROTECTED_BRANCHES.has(name)) {
    return true;
  }
  // release/* and release-* patterns
  if (/^release[/-]/.test(name)) {
    return true;
  }
  return false;
}

/** Resolve the branch name and main repo root from a workspace descriptor. */
function resolveArchiveTarget(workspace: {
  id: string;
  gitRuntime?: {
    currentBranch?: string | null;
    isPaseoOwnedWorktree?: boolean;
  } | null;
  githubRuntime?: {
    pullRequest?: {
      headRefName: string;
    } | null;
  } | null;
  project?: {
    checkout?: {
      isPaseoOwnedWorktree?: boolean;
      mainRepoRoot?: string | null;
    };
  };
  projectRootPath: string;
}): { branch: string; mainRepoRoot: string } | null {
  const isOwned =
    workspace.gitRuntime?.isPaseoOwnedWorktree === true ||
    workspace.project?.checkout?.isPaseoOwnedWorktree === true;
  if (!isOwned) {
    return null;
  }

  const branch =
    workspace.githubRuntime?.pullRequest?.headRefName ??
    workspace.gitRuntime?.currentBranch ??
    null;
  if (!branch) {
    return null;
  }

  // Never delete main-line branches. A Paseo worktree may check out an
  // existing branch like `main`; deleting it would destroy the main line.
  if (isProtectedBranch(branch)) {
    return null;
  }

  const mainRepoRoot =
    workspace.project?.checkout?.mainRepoRoot ??
    workspace.projectRootPath ??
    null;
  if (!mainRepoRoot) {
    return null;
  }

  return { branch, mainRepoRoot };
}

type WorkspaceDescriptor = Parameters<typeof resolveArchiveTarget>[0];
type WorkspaceUpdate = {
  kind: string;
  id?: string;
  workspace?: WorkspaceDescriptor;
};

// Cache of Paseo-owned worktree targets, keyed by workspace id.
// The daemon's archive flow emits a `remove` event (without the full
// descriptor) once archiving completes, so we remember the branch and
// main repo root from earlier upserts and act on `remove`.
const cachedTargets = new Map<string, { branch: string; mainRepoRoot: string }>();

const client = createPaseoClient({
  url: DAEMON_URL,
  clientId: "archive-branch-cleanup",
});

let unsubscribe: (() => void) | null = null;

const handleUpdate = (update: WorkspaceUpdate) => {
  if (update.kind === "upsert" && update.workspace) {
    const ws = update.workspace;
    const target = resolveArchiveTarget(ws);
    if (target) {
      cachedTargets.set(ws.id, target);
    } else {
      cachedTargets.delete(ws.id);
    }
    return;
  }

  if (update.kind === "remove" && update.id) {
    const target = cachedTargets.get(update.id);
    if (target) {
      cachedTargets.delete(update.id);
      console.log(
        `[archive-branch-cleanup] Workspace ${update.id} removed; deleting branch "${target.branch}"`,
      );
      void deleteBranchAfterWorktreeGone(target.branch, target.mainRepoRoot, update.id);
    }
  }
};

void (async () => {
  try {
    await client.connect();
    // `list({ subscribe: {} })` both hydrates the initial workspace set
    // (populating the cache via upserts) and starts the subscription stream.
    await client.workspaces.list({ subscribe: {} });
    unsubscribe = client.workspaces.subscribe(handleUpdate);
    console.log("[archive-branch-cleanup] Watching workspace archive events");
  } catch (error) {
    console.error("[archive-branch-cleanup] Failed to start watcher", error);
  }
})();

(globalThis as Record<string, unknown>)[STOP_KEY] = () => {
  try {
    unsubscribe?.();
    void client.close();
    console.log("[archive-branch-cleanup] Stopped watching");
  } catch (error) {
    console.error("[archive-branch-cleanup] Error during cleanup", error);
  }
};