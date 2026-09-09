import type { PluginServerContext } from "@getpaseo/plugin/server";
import { watchArchivedWorkspaces } from "./server/watcher";

export default function contribute(server: PluginServerContext) {
  const removeHook = watchArchivedWorkspaces((name, handler) => server.on(name, handler));
  return () => {
    removeHook();
  };
}
