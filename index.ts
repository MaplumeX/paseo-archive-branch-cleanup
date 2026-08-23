import type { PluginContext } from "@getpaseo/plugin";
import "./watcher.server";

const STOP_KEY = "__archive_branch_cleanup_stop__";

export default function contribute(plugin: PluginContext) {
  return () => {
    const stop = (globalThis as Record<string, unknown>)[STOP_KEY];
    if (typeof stop === "function") {
      stop();
    }
  };
}