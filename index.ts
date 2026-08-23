import type { PluginContext } from "@getpaseo/plugin";
import { MainSurface } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", MainSurface);
  plugin.addSidebarItem({
    id: "main",
    title: "My plugin",
    icon: "Blocks",
    surface: "main",
  });
  return () => {};
}
