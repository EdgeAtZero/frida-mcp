/**
 * Device tools — enumerate and resolve Frida devices.
 * Ported from Python cli.py with identical semantics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import frida from "frida";
import type { RemoteDeviceOptions } from "frida";
import { z } from "zod";

/** Upper bound for the reachability probe, so a stuck transport cannot hang the call. */
const PROBE_TIMEOUT_MS = 10_000;

export function registerDeviceTools(server: McpServer): void {
  server.tool(
    "enumerate_devices",
    "List all Frida-visible devices (local, USB, remote)",
    {},
    async () => {
      const devices = await frida.enumerateDevices();
      const result = devices.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_device",
    "Get a specific device by its ID",
    { device_id: z.string().describe("The device ID to look up") },
    async ({ device_id }) => {
      const device = await frida.getDevice(device_id);
      const result = { id: device.id, name: device.name, type: device.type };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_usb_device",
    "Get the USB-connected device (typically an Android phone)",
    {},
    async () => {
      const device = await frida.getUsbDevice();
      const result = { id: device.id, name: device.name, type: device.type };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_local_device",
    "Get the local (host) device",
    {},
    async () => {
      const device = await frida.getLocalDevice();
      const result = { id: device.id, name: device.name, type: device.type };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "connect_remote_device",
    "Register a remote frida-server as a device and return the id to pass as `device_id` to the other tools. " +
      "Use this for targets Frida does not auto-discover, such as a frida-server exposed on the network " +
      "instead of reached over USB/adb, optionally protected by a token or TLS. " +
      "Registration is lazy and never opens a connection, so the tool probes the device once (bounded to " +
      "10s) and reports `reachable`; the returned id stays usable even when the probe fails. " +
      "A stale registration for the same address is dropped first, because Frida keeps the options from the " +
      "first registration, which would otherwise silently ignore changed credentials.",
    {
      address: z
        .string()
        .describe("Remote frida-server address as host:port (e.g. frida.example.com:27042)"),
      token: z
        .string()
        .optional()
        .describe("Bearer token, for a frida-server that requires authentication"),
      certificate: z
        .string()
        .optional()
        .describe("PEM certificate, for a TLS-enabled frida-server"),
      origin: z
        .string()
        .optional()
        .describe("Origin presented to the server"),
      keepalive_interval: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Keepalive interval in seconds, for long-lived connections"),
    },
    async ({ address, token, certificate, origin, keepalive_interval }) => {
      try {
        const options: RemoteDeviceOptions = {};
        if (token !== undefined) options.token = token;
        if (certificate !== undefined) options.certificate = certificate;
        if (origin !== undefined) options.origin = origin;
        if (keepalive_interval !== undefined) options.keepaliveInterval = keepalive_interval;

        const manager = frida.getDeviceManager();

        // Frida keys a remote device by address and keeps the options from the
        // first registration, so re-connecting with changed credentials would
        // silently keep the old ones. Drop any stale entry first.
        try {
          await manager.removeRemoteDevice(address);
        } catch {
          // Never registered: the normal first-connect path.
        }

        const device = await manager.addRemoteDevice(
          address,
          Object.keys(options).length > 0 ? options : undefined,
        );

        // addRemoteDevice only records the address: a closed port or a rejected
        // token still returns a device object. Probe once so the caller does
        // not mistake registration for a working connection. The probe is
        // bounded because a misconfigured transport (e.g. a certificate
        // against a server that does not speak TLS) can otherwise leave the
        // request hanging until the MCP client gives up.
        const result: {
          id: string;
          name: string;
          type: string;
          reachable: boolean;
          process_count?: number;
          error?: string;
        } = { id: device.id, name: device.name, type: device.type, reachable: false };

        const cancellable = new frida.Cancellable();
        const timer = setTimeout(() => cancellable.cancel(), PROBE_TIMEOUT_MS);
        try {
          result.process_count = (await device.enumerateProcesses({}, cancellable)).length;
          result.reachable = true;
        } catch (e) {
          result.error = String(e);
        } finally {
          clearTimeout(timer);
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "error", error: String(e) }),
          }],
        };
      }
    },
  );
}
