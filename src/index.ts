#!/usr/bin/env node
/**
 * Frida MCP Server (TypeScript) — entry point.
 *
 * Creates an McpServer connected via stdio. The tool and resource surface is
 * assembled in `surface.ts`.
 *
 * Flags:
 *   --router-only   advertise search_tools/describe_tool/execute_tool instead
 *                   of every tool, keeping the schema payload constant.
 *                   Also selectable with FRIDA_MCP_ROUTER_ONLY=1.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerServerSurface } from "./surface.js";

const ROUTER_ONLY = process.argv.includes("--router-only") || process.env.FRIDA_MCP_ROUTER_ONLY === "1";

async function main() {
  const server = new McpServer({
    name: "frida",
    version: "1.3.1",
  });

  const captured = registerServerSurface(server, ROUTER_ONLY);
  if (ROUTER_ONLY) {
    console.error(
      `frida-mcp: router-only mode — ${captured.length} tools behind search_tools/describe_tool/execute_tool`,
    );
  }

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
