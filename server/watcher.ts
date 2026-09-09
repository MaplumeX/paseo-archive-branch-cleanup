import type { PluginHookContext, PluginHookWorkspace } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deleteBranchAfterWorktreeGone } from "./branch";

const execFileAsync = promisify(execFile);

/** Branch names that must never be deleted, even on a Paseo-owned worktree.
 * Covers common main-line branches. A Paseo worktree can check out an existing
 * branch (e.g. opening a worktree on `main`), so `isPaseoOwnedWorktree` alone
 * is not enough to keep the main branch safe. */
const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "dev",
  "production",
  "prod",
]);

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

/** Persisted workspace record shape from the daemon's workspaces.json. */
interface PersistedWorkspace {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: "directory" | "local_checkout" | "checkout" | "worktree";
  branch?: string | null;
  worktreeRoot?: string | null;
  baseBranch?: string | null;
  isPaseoOwnedWorktree: boolean;
  mainRepoRoot?: string | null;
  archivedAt?: string | null;
}

/** Resolve the branch name and main repo root from a persisted record. */
function resolveArchiveTarget(
  workspace: PersistedWorkspace,
): { branch: string; mainRepoRoot: string } | null {
  if (!workspace.isPaseoOwnedWorktree) {
    return null;
  }

  const branch = workspace.branch ?? null;
  if (!branch) {
    return null;
  }

  // Never delete main-line branches. A Paseo worktree may check out an
  // existing branch like `main`; deleting it would destroy the main line.
  if (isProtectedBranch(branch)) {
    return null;
  }

  const mainRepoRoot = workspace.mainRepoRoot ?? null;
  if (!mainRepoRoot) {
    return null;
  }

  return { branch, mainRepoRoot };
}

/** Read the daemon's persisted workspace records. The SDK cannot fetch an
 * archived workspace (refresh() returns null once the archive completes), but
 * the record stays in workspaces.json with branch and repo information. */
async function readPersistedWorkspaces(): Promise<PersistedWorkspace[]> {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const file = join(home, "projects", "workspaces.json");
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as PersistedWorkspace[];
  } catch (error) {
    console.error("[archive-branch-cleanup] Failed to read persisted workspaces", error);
    return [];
  }
}

/** Register the workspace.archived hook that cleans up the branch.
 * Returns the hook remover. */
export function watchArchivedWorkspaces(
  on: (
    name: "workspace.archived",
    handler: (
      event: { workspace: PluginHookWorkspace },
      context: PluginHookContext,
    ) => void | Promise<void>,
  ) => () => void,
): () => void {
  const remove = on("workspace.archived", async (event) => {
    const workspaceId = event.workspace.id;
    try {
      const workspaces = await readPersistedWorkspaces();
      const record = workspaces.find((ws) => ws.workspaceId === workspaceId);
      if (!record) {
        console.log(
          `[archive-branch-cleanup] No persisted record for ${workspaceId}; skipping`,
        );
        return;
      }
      const target = resolveArchiveTarget(record);
      if (!target) {
        console.log(
          `[archive-branch-cleanup] Workspace ${workspaceId} is not a cleanable Paseo-owned worktree; skipping`,
        );
        return;
      }
      console.log(
        `[archive-branch-cleanup] Workspace ${workspaceId} archived; deleting branch "${target.branch}"`,
      );
      await deleteBranchAfterWorktreeGone(target.branch, target.mainRepoRoot, workspaceId);
    } catch (error) {
      console.error(`[archive-branch-cleanup] Error handling archive of ${workspaceId}`, error);
    }
  });

  return () => {
    remove();
  };
}
