import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "child_process";
import { createConnection } from "net";

export default function (pi: ExtensionAPI) {
  let lastReportedCost = -1;
  const surfaceId = process.env.CMUX_SURFACE_ID ?? "";
  const workspaceId = process.env.CMUX_WORKSPACE_ID ?? "";

  function buildCommand(totalCost: number, totalInput: number, totalOutput: number,
    totalCacheRead: number, totalCacheWrite: number, modelId: string) {
    const socketCmd = `report_tokens --cost=${totalCost.toFixed(4)}`
      + ` --input=${totalInput} --output=${totalOutput}`
      + ` --cache-read=${totalCacheRead} --cache-write=${totalCacheWrite}`
      + ` --model=${modelId}`
      + (surfaceId ? ` --surface=${surfaceId}` : "")
      + (workspaceId ? ` --tab=${workspaceId}` : "");

    // CLI auto-resolves surface/workspace from env, but we pass explicitly too
    const cliArgs = [
      "report-tokens",
      "--cost", totalCost.toFixed(4),
      "--input", String(totalInput),
      "--output", String(totalOutput),
      "--cache-read", String(totalCacheRead),
      "--cache-write", String(totalCacheWrite),
      "--model", modelId,
    ];

    return { socketCmd, cliArgs };
  }

  function sendViaSocket(cmd: string) {
    const socketPath = process.env.CMUX_SOCKET_PATH
      ?? process.env.CMUX_SOCKET
      ?? "/tmp/cmux.sock";

    try {
      const sock = createConnection(socketPath);
      sock.on("error", () => {});
      sock.write(cmd + "\n");
      sock.end();
    } catch {
      // silently ignore
    }
  }

  function reportTokens(ctx: any) {
    const branch = ctx.sessionManager.getBranch();
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;

    for (const entry of branch) {
      const msg = entry.message;
      if (msg?.role === "assistant" && msg.usage) {
        totalInput += msg.usage.input ?? 0;
        totalOutput += msg.usage.output ?? 0;
        totalCacheRead += msg.usage.cacheRead ?? 0;
        totalCacheWrite += msg.usage.cacheWrite ?? 0;
        totalCost += msg.usage.cost?.total ?? 0;
      }
    }

    // Debounce: skip if cost hasn't meaningfully changed
    if (Math.abs(totalCost - lastReportedCost) < 0.001) return;
    lastReportedCost = totalCost;

    const modelId = ctx.model?.id ?? "unknown";
    const { socketCmd, cliArgs } = buildCommand(
      totalCost, totalInput, totalOutput, totalCacheRead, totalCacheWrite, modelId
    );

    // Try CLI first (handles socket discovery + workspace resolution),
    // fall back to direct socket if CLI fails or isn't available.
    execFile("cmux", cliArgs, { timeout: 3000 }, (error) => {
      if (error) {
        sendViaSocket(socketCmd);
      }
    });
  }

  pi.on("agent_end", async (_event, ctx) => {
    reportTokens(ctx);
  });
}
