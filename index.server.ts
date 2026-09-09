import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startWatcher } from "./server/watcher";

export default function contribute(server: PluginServerContext) {
  const stop = startWatcher();
  return () => {
    stop();
  };
}
