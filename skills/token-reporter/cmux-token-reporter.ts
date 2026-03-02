import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "child_process";

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

    const modelId = ctx.model?.id ?? "unknown";

    const args = [
      "report-tokens",
      "--cost", totalCost.toFixed(4),
      "--input", String(totalInput),
      "--output", String(totalOutput),
      "--cache-read", String(totalCacheRead),
      "--cache-write", String(totalCacheWrite),
      "--model", modelId,
    ];

    // execFile avoids shell escaping issues and is non-blocking
    execFile("cmux", args, { timeout: 3000 }, () => {
      // silently ignore errors — cmux may not be running
    });
  }

  pi.on("agent_end", async (_event, ctx) => {
    reportTokens(ctx);
  });
}
