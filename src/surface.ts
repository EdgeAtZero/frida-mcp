/**
 * The server's complete tool and resource surface, assembled in one place so
 * the entry point, the integration tests and router-only mode all publish
 * exactly the same set.
 *
 * @module
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDeviceTools } from "./tools/device.js";
import { registerProcessTools } from "./tools/process.js";
import { registerSessionTools } from "./tools/session.js";
import { registerScriptMgmtTools } from "./tools/script-mgmt.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerJavaTools } from "./tools/java.js";
import { registerNativeHookTools } from "./tools/native-hooks.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerAndroidTools } from "./tools/android.js";
import { registerExportTools } from "./tools/export.js";
import { registerBootstrapTools } from "./tools/bootstrap.js";
import { registerRecipeTools } from "./tools/recipes.js";
import { registerProcessInventoryTool } from "./tools/process-inventory.js";
import { registerAntiDetectionTools } from "./tools/anti-detection.js";
import { registerStaticTools } from "./tools/static.js";
import { registerSourceJumpTool } from "./tools/source-jump.js";
import { registerResources } from "./resources.js";
import { createToolRecorder, registerRouterTools, type CapturedTool } from "./router.js";

/**
 * Register every tool module against `host`.
 *
 * Passing a recorder instead of the real server captures the registrations
 * rather than publishing them — see {@link registerServerSurface}.
 */
export function registerAllTools(host: McpServer): void {
  registerDeviceTools(host);
  registerProcessTools(host);
  registerSessionTools(host);
  registerScriptMgmtTools(host);
  registerMemoryTools(host);
  registerJavaTools(host);
  registerNativeHookTools(host);
  registerDocsTools(host);
  registerAndroidTools(host);
  registerExportTools(host);
  registerBootstrapTools(host);
  registerRecipeTools(host);
  registerProcessInventoryTool(host);
  registerAntiDetectionTools(host);
  registerStaticTools(host);
  registerSourceJumpTool(host);
}

/**
 * Publish the full surface on `server`.
 *
 * Normally every tool is registered directly. With `routerOnly`, the tool
 * modules feed a recorder and three router tools (`search_tools`,
 * `describe_tool`, `execute_tool`) replace them, keeping the advertised tool
 * count constant no matter how many tools the server grows. Resources are
 * unaffected in both modes.
 *
 * @returns the captured tools, which is empty unless `routerOnly` is set.
 */
export function registerServerSurface(server: McpServer, routerOnly = false): CapturedTool[] {
  const captured: CapturedTool[] = [];

  registerAllTools(routerOnly ? createToolRecorder(server, captured) : server);
  registerResources(server);

  if (routerOnly) registerRouterTools(server, captured);

  return captured;
}
