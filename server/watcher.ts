import type { PluginHookContext, PluginHookWorkspace } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { deleteBranchAfterWorktreeGone } from "./branch";

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

interface WorkspaceDescriptor {
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
  } | null;
  projectRootPath: string;
}

/** Resolve the branch name and main repo root from a workspace descriptor. */
function resolveArchiveTarget(
  workspace: WorkspaceDescriptor,
): { branch: string; mainRepoRoot: string } | null {
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
    workspace.project?.checkout?.mainRepoRoot ?? workspace.projectRootPath ?? null;
  if (!mainRepoRoot) {
    return null;
  }

  return { branch, mainRepoRoot };
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
  const inflight = new Set<Promise<void>>();

  const remove = on("workspace.archived", async (event, context) => {
    const workspaceId = event.workspace.id;
    try {
      const workspace = await fetchWorkspace(context.paseo, workspaceId);
      if (!workspace) {
        return;
      }
      const target = resolveArchiveTarget(workspace);
      if (!target) {
        return;
      }
      console.log(
        `[archive-branch-cleanup] Workspace ${workspaceId} archived; deleting branch "${target.branch}"`,
      );
      await deleteBranchAfterWorktreeGone(target.branch, target.mainRepoRoot, workspaceId);
    } finally {
      // Nothing to track here; kept for symmetry if needed later.
    }
  });

  return () => {
    remove();
  };
}

async function fetchWorkspace(
  paseo: PaseoApi,
  workspaceId: string,
): Promise<WorkspaceDescriptor | null> {
  try {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    return (workspace as WorkspaceDescriptor | null) ?? null;
  } catch (error) {
    console.error(
      `[archive-branch-cleanup] Failed to fetch workspace ${workspaceId}`,
      error,
    );
    return null;
  }
}
