import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConnection } from "net";

export default function (pi: ExtensionAPI) {
  let lastReportedCost = -1;

  function reportTokens(ctx: any) {
    const branch = ctx.sessionManager.getBranch();
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;

    for (const entry of branch) {
      if (entry.role === "assistant" && entry.usage) {
        totalInput += entry.usage.input ?? 0;
        totalOutput += entry.usage.output ?? 0;
        totalCacheRead += entry.usage.cacheRead ?? 0;
        totalCacheWrite += entry.usage.cacheWrite ?? 0;
        totalCost += entry.usage.cost?.total ?? 0;
      }
    }

    // Debounce: skip if cost hasn't meaningfully changed
    if (Math.abs(totalCost - lastReportedCost) < 0.001) return;
    lastReportedCost = totalCost;

    const socketPath = process.env.CMUX_SOCKET_PATH
      ?? process.env.CMUX_SOCKET
      ?? "/tmp/cmux.sock";

    const modelId = ctx.model?.id ?? "unknown";

    const cmd = `report_tokens --cost=${totalCost.toFixed(4)}`
      + ` --input=${totalInput} --output=${totalOutput}`
      + ` --cache-read=${totalCacheRead} --cache-write=${totalCacheWrite}`
      + ` --model=${modelId}`;

    try {
      const sock = createConnection(socketPath);
      sock.on("error", () => {}); // silently ignore connection errors
      sock.write(cmd + "\n");
      sock.end();
    } catch {
      // cmux may not be running — silently ignore
    }
  }

  pi.on("agent_turn_complete", async (_event, ctx) => {
    reportTokens(ctx);
  });
}
