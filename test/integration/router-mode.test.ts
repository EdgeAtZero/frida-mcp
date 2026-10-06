import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerServerSurface } from "../../src/surface.js";

/** The three tools router-only mode publishes in place of everything else. */
const ROUTER_TOOLS = ["search_tools", "describe_tool", "execute_tool"];

/** Connect a client to a fresh server built in the requested surface mode. */
async function connect(routerOnly: boolean) {
  const server = new McpServer({ name: "frida-router-test", version: "1.0.0" });
  registerServerSurface(server, routerOnly);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type ToolResult = { content: { text: string }[]; isError?: boolean };
const body = (result: unknown) => JSON.parse((result as ToolResult).content[0].text);

describe("router-only mode", () => {
  it("advertises the router tools instead of every tool", async () => {
    const { client, close } = await connect(true);
    try {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [...ROUTER_TOOLS].sort(),
      );
    } finally {
      await close();
    }
  });

  it("cuts the advertised schema payload by more than an order of magnitude", async () => {
    // The whole point of the mode: a client pays for these schemas on every
    // request. Keep the threshold loose so the test tracks the intent rather
    // than an exact byte count.
    const full = await connect(false);
    const router = await connect(true);
    try {
      const fullBytes = JSON.stringify((await full.client.listTools()).tools).length;
      const routerBytes = JSON.stringify((await router.client.listTools()).tools).length;
      assert.ok(
        routerBytes * 5 < fullBytes,
        `router-only payload (${routerBytes}B) should be far below full mode (${fullBytes}B)`,
      );
    } finally {
      await full.close();
      await router.close();
    }
  });

  it("search_tools matches names and descriptions", async () => {
    const { client, close } = await connect(true);
    try {
      const page = body(
        await client.callTool({ name: "search_tools", arguments: { query: "remote frida-server" } }),
      );
      const target = page.tools.find((tool: { name: string }) => tool.name === "connect_remote_device");
      assert.ok(target, "query should surface connect_remote_device");
      assert.deepEqual(target.required, ["address"]);
      assert.ok(target.params.includes("token"));
      assert.ok(
        page.tools.every((tool: { name: string; description: string }) =>
          `${tool.name} ${tool.description}`.toLowerCase().includes("remote"),
        ),
      );
    } finally {
      await close();
    }
  });

  it("search_tools pages with limit and offset", async () => {
    const { client, close } = await connect(true);
    try {
      const all = body(await client.callTool({ name: "search_tools", arguments: {} }));
      assert.ok(all.total_matches > 5, "expected the full tool set to be reachable");

      const first = body(await client.callTool({ name: "search_tools", arguments: { limit: 5 } }));
      assert.equal(first.returned_count, 5);
      assert.equal(first.next_offset, 5);

      const second = body(
        await client.callTool({ name: "search_tools", arguments: { limit: 5, offset: 5 } }),
      );
      assert.equal(second.offset, 5);
      assert.notDeepEqual(
        first.tools.map((tool: { name: string }) => tool.name),
        second.tools.map((tool: { name: string }) => tool.name),
      );
    } finally {
      await close();
    }
  });

  it("describe_tool returns the full description and input schema", async () => {
    const { client, close } = await connect(true);
    try {
      const described = body(
        await client.callTool({ name: "describe_tool", arguments: { name: "connect_remote_device" } }),
      );
      assert.equal(described.name, "connect_remote_device");
      assert.deepEqual(described.inputSchema.required, ["address"]);
      assert.equal(described.inputSchema.properties.address.type, "string");
      assert.equal(described.inputSchema.properties.keepalive_interval.type, "integer");
      // The full text, not the abbreviated form search_tools reports.
      assert.ok(described.description.length > 120, "describe_tool must not abbreviate");

      const missing = await client.callTool({ name: "describe_tool", arguments: { name: "no_such_tool" } });
      assert.equal(missing.isError, true);
      assert.equal(body(missing).status, "error");
    } finally {
      await close();
    }
  });

  it("execute_tool returns exactly what a direct call returns", async () => {
    const direct = await connect(false);
    const routed = await connect(true);
    try {
      const args = { query: "Interceptor.attach", limit: 1, offset: 0, snippet_chars: 200 };
      const directResult = await direct.client.callTool({ name: "search_frida_docs", arguments: args });
      const routedResult = await routed.client.callTool({
        name: "execute_tool",
        arguments: { tool: "search_frida_docs", arguments: args },
      });
      assert.equal(routedResult.isError ?? false, false);
      assert.deepEqual(routedResult.content, directResult.content);
    } finally {
      await direct.close();
      await routed.close();
    }
  });

  it("execute_tool validates arguments against the target schema", async () => {
    const { client, close } = await connect(true);
    try {
      const invalid = await client.callTool({
        name: "execute_tool",
        arguments: { tool: "connect_remote_device", arguments: { address: 123 } },
      });
      assert.equal(invalid.isError, true);
      const reported = body(invalid);
      assert.equal(reported.error, "Invalid arguments");
      assert.equal(reported.issues[0].path, "address");

      const unknown = await client.callTool({ name: "execute_tool", arguments: { tool: "no_such_tool" } });
      assert.equal(unknown.isError, true);
      assert.equal(body(unknown).status, "error");
    } finally {
      await close();
    }
  });

  it("leaves resources published", async () => {
    const { client, close } = await connect(true);
    try {
      const uris = (await client.listResources()).resources.map((resource) => resource.uri);
      assert.ok(uris.includes("frida://version"));
      assert.ok(uris.includes("frida://docs/instrumentation"));
    } finally {
      await close();
    }
  });
});
