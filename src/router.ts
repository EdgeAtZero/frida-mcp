/**
 * Router-only mode — advertise three tools instead of every tool.
 *
 * A client that advertises all tools pays for all of their schemas on every
 * request. With `--router-only` (or `FRIDA_MCP_ROUTER_ONLY=1`) the tool modules
 * register into a recorder instead of the server, and this module publishes:
 *
 *   search_tools  — find tools by name or description
 *   describe_tool — full description and input schema for one tool
 *   execute_tool  — run one tool by name with JSON arguments
 *
 * The implementations are untouched: the recorder captures the same
 * `(name, description, schema, handler)` tuples the modules already hand to
 * `server.tool()`, so a routed call runs exactly the code a direct call would.
 *
 * @module
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";

/** Characters of a tool description kept in `search_tools` output. */
const SEARCH_DESCRIPTION_CHARS = 120;
/** Default and maximum number of tools `search_tools` returns per page. */
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 100;

/** One tool captured from a registration module. */
export interface CapturedTool {
  name: string;
  description: string;
  /** The raw zod shape the module passed to `server.tool()`. */
  shape: Record<string, ZodTypeAny>;
  handler: (args: Record<string, unknown>) => unknown;
}

const result = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Return an `McpServer` look-alike whose `tool()` records registrations instead
 * of publishing them. Everything else (resources, prompts) still reaches the
 * real server through the proxy.
 */
export function createToolRecorder(server: McpServer, captured: CapturedTool[]): McpServer {
  const record = (
    name: string,
    description: string,
    shape: Record<string, ZodTypeAny>,
    handler: (args: never) => unknown,
  ) => {
    captured.push({
      name,
      description,
      shape,
      handler: handler as (args: Record<string, unknown>) => unknown,
    });
    // The modules ignore the return value; only the capture matters here.
    return { enable() {}, disable() {}, update() {}, remove() {} } as never;
  };

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === "tool") return record;
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Compact one-line form of a description, for search results. */
function summarize(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= SEARCH_DESCRIPTION_CHARS
    ? flat
    : `${flat.slice(0, SEARCH_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** Publish the router tools that stand in for the captured ones. */
export function registerRouterTools(server: McpServer, captured: CapturedTool[]): void {
  const byName = new Map(captured.map((tool) => [tool.name, tool]));

  server.tool(
    "search_tools",
    `Find tools on this server by name or description. Returns ${SEARCH_DEFAULT_LIMIT} per page by default; ` +
      "descriptions are abbreviated here and returned in full by describe_tool. " +
      "This server runs in router-only mode, so its tools are reached through execute_tool.",
    {
      query: z
        .string()
        .optional()
        .describe("Case-insensitive words to match against tool names and descriptions; omit to list everything"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_MAX_LIMIT)
        .optional()
        .describe(`Tools per page (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT})`),
      offset: z.number().int().min(0).optional().describe("Tools to skip, for paging"),
    },
    async ({ query, limit, offset }) => {
      const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matched = captured.filter((tool) => {
        if (terms.length === 0) return true;
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });

      const start = offset ?? 0;
      const size = limit ?? SEARCH_DEFAULT_LIMIT;
      const page = matched.slice(start, start + size);

      return result({
        total_matches: matched.length,
        offset: start,
        returned_count: page.length,
        next_offset: start + page.length < matched.length ? start + page.length : null,
        tools: page.map((tool) => {
          const names = Object.keys(tool.shape);
          return {
            name: tool.name,
            description: summarize(tool.description),
            params: names,
            required: names.filter((name) => !tool.shape[name].isOptional()),
          };
        }),
      });
    },
  );

  server.tool(
    "describe_tool",
    "Return one tool's full description and JSON input schema. Call this before execute_tool " +
      "when you need the exact parameter shape.",
    {
      name: z.string().describe("Exact tool name, as reported by search_tools"),
    },
    async ({ name }) => {
      const tool = byName.get(name);
      if (!tool) {
        return result({ status: "error", error: `Unknown tool: ${name}`, hint: "Call search_tools first." }, true);
      }
      return result({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchemaCompat(z.object(tool.shape), {
          strictUnions: true,
          pipeStrategy: "input",
        }),
      });
    },
  );

  server.tool(
    "execute_tool",
    "Run one tool by name. `arguments` must match the inputSchema that describe_tool reports. " +
      "The result is the tool's own result, passed through unchanged.",
    {
      tool: z.string().describe("Exact tool name, as reported by search_tools"),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe("Arguments object for that tool; omit for tools that take none"),
    },
    async ({ tool: name, arguments: args }) => {
      const tool = byName.get(name);
      if (!tool) {
        return result({ status: "error", error: `Unknown tool: ${name}`, hint: "Call search_tools first." }, true);
      }

      // Nothing else validates in router mode: the SDK would have checked the
      // arguments against this shape had the tool been registered directly.
      const parsed = z.object(tool.shape).safeParse(args ?? {});
      if (!parsed.success) {
        return result(
          {
            status: "error",
            tool: name,
            error: "Invalid arguments",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join(".") || "(root)",
              message: issue.message,
            })),
          },
          true,
        );
      }

      try {
        return (await tool.handler(parsed.data as Record<string, unknown>)) as CallToolResult;
      } catch (e) {
        return result({ status: "error", tool: name, error: String(e) }, true);
      }
    },
  );
}
