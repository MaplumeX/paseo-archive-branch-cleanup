# paseo-archive-branch-cleanup

A [Paseo](https://paseo.sh) plugin that automatically deletes the local git branch when a Paseo-owned worktree workspace is archived.

## Why

When you archive a PR worktree workspace in Paseo, the daemon removes the worktree directory but leaves the local branch behind. Over time these stale branches accumulate. This plugin cleans them up automatically.

## How it works

The plugin runs a background watcher inside the Paseo daemon plugin subprocess:

1. Connects to the local Paseo daemon via `@getpaseo/client`
2. Subscribes to workspace update events
3. Caches branch and repo info for Paseo-owned worktree workspaces from upsert events
4. On a workspace `remove` event, deletes the cached branch from the main repo with `git branch -D`

Branch deletion retries for up to 30 seconds, because the daemon may still be removing the worktree (the branch stays checked out until the worktree is gone).

## Safety

- Only touches workspaces where `gitRuntime.isPaseoOwnedWorktree === true` (branches Paseo created)
- Only deletes the **local** branch (`git branch -D`), never the remote
- Branch name is resolved from `githubRuntime.pullRequest.headRefName`, falling back to `gitRuntime.currentBranch`
- Deletion runs in the main repo root (`project.checkout.mainRepoRoot`), not the worktree

## Install

```sh
paseo plugin install /absolute/path/to/paseo-archive-branch-cleanup
```

Requires the daemon-wide **Enable plugins** switch under Settings → Plugins.

## Requirements

- Paseo daemon reachable at `ws://127.0.0.1:6769` (default loopback)
- Git CLI on PATH

## Development

```sh
npm run typecheck        # type-check
paseo plugin reload paseo-archive-branch-cleanup   # reload after edits
paseo plugin logs paseo-archive-branch-cleanup      # view backend output
```

## License

MIT