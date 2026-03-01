# Token Cost Sidebar Widget — Feature Plan

## Overview

Add a persistent widget at the bottom of cmux's vertical tab sidebar that displays live token usage and cost for each running coding agent. The initial implementation targets **pi coding agent** (`@mariozechner/pi-coding-agent`), with the architecture designed for future agent support (Claude Code, Aider, etc.).

The widget sits between the tab list and the existing footer (UpdatePill / SidebarDevFooter) and shows a compact per-workspace cost summary that updates in real time.

---

## 1. Data Flow Architecture

```
┌──────────────────────────────────────────────────────────┐
│  pi coding agent (running in a terminal pane)            │
│                                                          │
│  pi extension (cmux-token-reporter.ts)                   │
│    ├─ hooks agent_turn_complete / message_update events   │
│    ├─ reads ctx.sessionManager.getBranch() for usage      │
│    └─ sends stats via cmux socket command                 │
│       `report_meta token_cost <formatted> --icon=...`    │
│       OR a new dedicated socket command `report_tokens`   │
└────────────────────────┬─────────────────────────────────┘
                         │  unix socket
                         ▼
┌──────────────────────────────────────────────────────────┐
│  cmux (TerminalController.swift)                         │
│    ├─ parses `report_tokens` command                     │
│    ├─ updates Workspace.tokenUsage published property    │
│    └─ off-main parsing, main.async for model mutation    │
└────────────────────────┬─────────────────────────────────┘
                         │  @Published
                         ▼
┌──────────────────────────────────────────────────────────┐
│  TokenCostSidebarWidget (SwiftUI)                        │
│    ├─ observes TabManager.tabs[*].tokenUsage             │
│    ├─ shows per-workspace breakdown                      │
│    └─ shows session total across all workspaces          │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Pi Extension — `cmux-token-reporter.ts`

A pi extension installed at `~/.pi/agent/extensions/cmux-token-reporter.ts` (or bundled with cmux's skills directory) that reports token stats to cmux.

### Source of truth

Pi's `ctx.sessionManager.getBranch()` returns the full message branch. Each `AssistantMessage` has a `.usage` field:

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;   // USD
  };
}
```

### Reporting mechanism

**Option A — Use existing `report_meta` socket command (simplest, no Swift changes needed initially):**

```bash
# From extension, shell out to cmux CLI:
cmux report_meta token_cost "$0.42 · 105k tokens" \
  --icon="sf:dollarsign.circle" \
  --color="#4CAF50" \
  --priority=999
```

This immediately appears in the sidebar metadata rows for the active workspace. However, it mixes with other metadata and doesn't enable a dedicated aggregated widget.

**Option B — New dedicated `report_tokens` socket command (recommended):**

```
report_tokens --input=50000 --output=10000 --cache-read=40000 --cache-write=5000 --cost=0.45 [--tab=X] [--panel=Y]
```

This stores structured data on the Workspace, enabling a richer dedicated UI.

### Extension implementation sketch

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";

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

    // Detect cmux socket path from environment
    const socketPath = process.env.CMUX_SOCKET
      ?? findCmuxSocket();  // scan /tmp/cmux-*.sock

    if (!socketPath) return;

    try {
      // Option B: structured command
      execSync(
        `echo 'report_tokens --input=${totalInput} --output=${totalOutput}` +
        ` --cache-read=${totalCacheRead} --cache-write=${totalCacheWrite}` +
        ` --cost=${totalCost.toFixed(4)}' | nc -U "${socketPath}"`,
        { timeout: 2000, stdio: "ignore" }
      );
    } catch {
      // Silently ignore — cmux may not be running
    }
  }

  pi.on("agent_turn_complete", async (_event, ctx) => {
    reportTokens(ctx);
  });
}
```

### Socket discovery

The extension needs to find the cmux socket. Strategies:
1. **`CMUX_SOCKET` env var** — cmux can set this in terminal environments it spawns
2. **Well-known path scan** — `/tmp/cmux-debug.sock`, `~/Library/Application Support/cmux/cmuxd.sock`
3. **`cmux` CLI** — if `cmux` is on PATH, use `cmux report_meta ...` directly

---

## 3. Swift Model Changes

### 3a. New `TokenUsageState` model

```swift
// Sources/TokenUsage.swift (new file)

struct TokenUsageState: Equatable {
    var input: Int = 0
    var output: Int = 0
    var cacheRead: Int = 0
    var cacheWrite: Int = 0
    var totalTokens: Int = 0
    var cost: Double = 0.0           // USD
    var lastUpdated: Date = Date()
    var agentType: AgentType = .unknown

    enum AgentType: String {
        case pi = "pi"
        case claudeCode = "claude-code"
        case aider = "aider"
        case unknown = "unknown"
    }

    var formattedCost: String {
        if cost < 0.01 {
            return String(format: "$%.4f", cost)
        } else if cost < 1.0 {
            return String(format: "$%.2f", cost)
        } else {
            return String(format: "$%.2f", cost)
        }
    }

    var formattedTokens: String {
        let total = input + output + cacheRead + cacheWrite
        if total >= 1_000_000 {
            return String(format: "%.1fM", Double(total) / 1_000_000)
        } else if total >= 1_000 {
            return String(format: "%.0fk", Double(total) / 1_000)
        }
        return "\(total)"
    }
}
```

### 3b. Add to `Workspace`

```swift
// In Sources/Workspace.swift, add to the Workspace class:
@Published var tokenUsage: TokenUsageState?

// Per-panel token usage (for split panes running different agents)
@Published var panelTokenUsage: [UUID: TokenUsageState] = [:]

// Computed aggregate for the workspace
var aggregateTokenUsage: TokenUsageState? {
    let usages = panelTokenUsage.values
    guard !usages.isEmpty else { return tokenUsage }
    var agg = TokenUsageState()
    for u in usages {
        agg.input += u.input
        agg.output += u.output
        agg.cacheRead += u.cacheRead
        agg.cacheWrite += u.cacheWrite
        agg.cost += u.cost
    }
    agg.totalTokens = agg.input + agg.output + agg.cacheRead + agg.cacheWrite
    agg.lastUpdated = usages.map(\.lastUpdated).max() ?? Date()
    return agg
}
```

### 3c. Socket command — `report_tokens`

Add to `TerminalController.swift` command dispatch:

```swift
case "report_tokens":
    return handleReportTokens(args)
```

Handler (follows socket command threading policy — parse off-main, minimal main.async):

```swift
private func handleReportTokens(_ args: String) -> String {
    let parsed = parseArgs(args)
    guard let costStr = parsed.options["cost"],
          let cost = Double(costStr) else {
        return "ERROR: --cost required"
    }

    let input = Int(parsed.options["input"] ?? "") ?? 0
    let output = Int(parsed.options["output"] ?? "") ?? 0
    let cacheRead = Int(parsed.options["cache-read"] ?? "") ?? 0
    let cacheWrite = Int(parsed.options["cache-write"] ?? "") ?? 0
    let agentType = TokenUsageState.AgentType(
        rawValue: parsed.options["agent"] ?? "unknown"
    ) ?? .unknown

    let state = TokenUsageState(
        input: input,
        output: output,
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: cost,
        lastUpdated: Date(),
        agentType: agentType
    )

    let tabId = resolveTabId(parsed.options["tab"])
    let panelId = resolvePanelId(parsed.options["panel"], tab: tabId)

    DispatchQueue.main.async {
        guard let workspace = self.resolveWorkspace(tabId) else { return }
        if let panelId {
            workspace.panelTokenUsage[panelId] = state
        } else {
            workspace.tokenUsage = state
        }
    }

    return "OK"
}
```

Add help text alongside existing report commands:

```
report_tokens --cost=<usd> [--input=N] [--output=N] [--cache-read=N] [--cache-write=N] [--agent=pi|claude-code|aider] [--tab=X] [--panel=Y] - Report token usage/cost
```

---

## 4. SwiftUI Widget — `TokenCostSidebarWidget`

### Location in sidebar

The widget sits in `VerticalTabsSidebar` between the `GeometryReader` (tab scroll area) and the existing footer (`SidebarDevFooter` / `UpdatePill`):

```swift
// In VerticalTabsSidebar body:
VStack(spacing: 0) {
    GeometryReader { proxy in
        // ... existing tab scroll view ...
    }

    // NEW: Token cost widget
    TokenCostSidebarWidget()
        .frame(maxWidth: .infinity, alignment: .leading)

    #if DEBUG
    SidebarDevFooter(updateViewModel: updateViewModel)
        .frame(maxWidth: .infinity, alignment: .leading)
    #else
    UpdatePill(model: updateViewModel)
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    #endif
}
```

### Widget design

```
┌─────────────────────────────┐
│ Sidebar tabs                │
│  ...                        │
│                             │
├─────────────────────────────┤  ← thin separator
│ 💰 $0.42 · 105k tokens     │  ← total across all workspaces
│    ws1: $0.25 (pi)          │  ← per-workspace breakdown
│    ws2: $0.17 (pi)          │     (collapsed by default)
├─────────────────────────────┤
│ UpdatePill / DevFooter      │
└─────────────────────────────┘
```

### Implementation

```swift
// Sources/TokenCostSidebarWidget.swift (new file)

import SwiftUI

struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = false

    private var activeUsages: [(workspace: Workspace, usage: TokenUsageState)] {
        tabManager.tabs.compactMap { ws in
            guard let usage = ws.aggregateTokenUsage ?? ws.tokenUsage else { return nil }
            return (workspace: ws, usage: usage)
        }
    }

    private var totalCost: Double {
        activeUsages.reduce(0) { $0 + $1.usage.cost }
    }

    private var totalTokens: Int {
        activeUsages.reduce(0) { $0 + $1.usage.totalTokens }
    }

    var body: some View {
        if !activeUsages.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                // Separator
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(height: 1)

                // Summary row (always visible)
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "dollarsign.circle")
                            .font(.system(size: 10, weight: .medium))
                        Text(formattedTotalCost)
                            .font(.system(size: 11, weight: .semibold))
                        Text("·")
                            .foregroundColor(.secondary)
                        Text(formattedTotalTokens)
                            .font(.system(size: 10))
                            .foregroundColor(.secondary)
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .foregroundColor(.primary)

                // Per-workspace breakdown (expanded)
                if isExpanded {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(activeUsages, id: \.workspace.id) { item in
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(agentColor(item.usage.agentType))
                                    .frame(width: 6, height: 6)
                                Text(item.workspace.title.prefix(20))
                                    .font(.system(size: 10))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer()
                                Text(item.usage.formattedCost)
                                    .font(.system(size: 10, weight: .medium))
                                    .monospacedDigit()
                            }
                            .foregroundColor(.secondary)
                        }
                    }
                    .padding(.leading, 4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private var formattedTotalCost: String {
        TokenUsageState(cost: totalCost).formattedCost
    }

    private var formattedTotalTokens: String {
        TokenUsageState(
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: totalTokens, cost: 0
        ).formattedTokens
    }

    private func agentColor(_ type: TokenUsageState.AgentType) -> Color {
        switch type {
        case .pi:        return .green
        case .claudeCode: return .purple
        case .aider:     return .orange
        case .unknown:   return .gray
        }
    }
}
```

---

## 5. Implementation Phases

### Phase 1 — MVP via `report_meta` (no Swift model changes)

**Goal:** Working end-to-end with zero cmux code changes. Uses existing sidebar metadata infrastructure.

1. Create `cmux-token-reporter.ts` pi extension
2. Extension uses `report_meta token_cost "$0.42" --icon="sf:dollarsign.circle" --priority=999`
3. Token cost appears in existing sidebar metadata rows per workspace
4. Ship as a pi skill or bundled extension

**Effort:** ~2 hours (extension only)

### Phase 2 — Dedicated `report_tokens` command + structured model

**Goal:** Structured data model enables aggregated widget and richer UI.

1. Add `TokenUsageState` struct (`Sources/TokenUsage.swift`)
2. Add `tokenUsage` / `panelTokenUsage` to `Workspace`
3. Add `report_tokens` socket command to `TerminalController.swift`
4. Add `clear_tokens` and `list_tokens` commands
5. Update pi extension to use `report_tokens`

**Effort:** ~4 hours

### Phase 3 — Dedicated sidebar widget

**Goal:** Polished, always-visible widget at bottom of sidebar.

1. Create `TokenCostSidebarWidget.swift`
2. Insert into `VerticalTabsSidebar` layout
3. Style to match sidebar aesthetic (blur, selection state awareness)
4. Add expand/collapse animation for per-workspace breakdown
5. Handle light/dark mode, active/inactive workspace colors

**Effort:** ~4 hours

### Phase 4 — Polish & additional agents

1. Add `CMUX_SOCKET` environment variable injection for spawned terminals
2. Auto-detect agent type from process tree / shell integration
3. Add support for Claude Code (`~/.claude/projects/` cost tracking)
4. Add support for Aider (parse output for cost lines)
5. Add tooltip with full token breakdown (input/output/cache)
6. Add session persistence for token stats (survive app restart)
7. Add cost alerts / budget thresholds (configurable)

**Effort:** ~8 hours

---

## 6. File Manifest

| File | Action | Description |
|------|--------|-------------|
| `Sources/TokenUsage.swift` | **New** | `TokenUsageState` model |
| `Sources/Workspace.swift` | Edit | Add `tokenUsage`, `panelTokenUsage` published properties |
| `Sources/TerminalController.swift` | Edit | Add `report_tokens`, `clear_tokens`, `list_tokens` commands |
| `Sources/ContentView.swift` | Edit | Insert `TokenCostSidebarWidget` into `VerticalTabsSidebar` |
| `Sources/TokenCostSidebarWidget.swift` | **New** | SwiftUI sidebar widget |
| `skills/token-reporter/` | **New** | Pi extension for token reporting |
| `features/token-cost/PLAN.md` | **New** | This plan |

---

## 7. Compatibility Notes

### Pi coding agent integration

- **RPC mode:** If cmux spawns pi via RPC (`pi --mode rpc`), cmux can call `get_session_stats` directly and skip the extension entirely. This is the cleanest path for deep integration.
- **Interactive mode:** The extension approach works when pi runs interactively in a terminal pane.
- **Socket discovery:** Pi extensions run in the same process as the agent, which runs inside a cmux terminal. The `CMUX_SOCKET` env var (injected by cmux into spawned shells) is the most reliable discovery mechanism.

### Threading policy compliance

- `report_tokens` follows the socket command threading policy: parse/validate off-main, coalesce off-main, `DispatchQueue.main.async` only for the `@Published` property mutation.
- No `DispatchQueue.main.sync` on the hot path.

### Socket focus policy compliance

- `report_tokens` is a telemetry command — no app activation, no window raising, no focus mutation.

---

## 8. Open Questions

1. **Widget visibility toggle** — Should there be a setting to hide the token cost widget? Probably yes, via `@AppStorage`.
2. **Historical cost tracking** — Should we persist cumulative cost across sessions/app restarts? Nice-to-have for Phase 4.
3. **Multi-window** — Each window has its own sidebar; the widget should show costs for workspaces visible in that window only (follows existing TabManager scoping).
4. **Currency formatting** — Always USD? Or respect locale? Start with USD since all LLM providers price in USD.
5. **RPC vs extension** — For deep pi integration, should cmux spawn pi in RPC mode and use `get_session_stats` directly? This bypasses the extension but requires cmux to manage the pi lifecycle.
