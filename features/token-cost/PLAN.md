# Token Cost Sidebar Widget — Feature Plan

> **Revised** after review (see `REVIEW.md`). Collapsed from 4 phases to 2. Dropped per-panel tracking, `AgentType` enum, and `report_meta` detour.

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
│    ├─ hooks agent_turn_complete events                   │
│    ├─ reads ctx.sessionManager.getBranch() for usage      │
│    ├─ debounces (skip if cost delta < $0.001)            │
│    └─ sends via Node net.connect() to cmux socket        │
│       `report_tokens --cost=0.45 --input=50000 ...`      │
└────────────────────────┬─────────────────────────────────┘
                         │  unix socket
                         ▼
┌──────────────────────────────────────────────────────────┐
│  cmux (TerminalController.swift)                         │
│    ├─ parses `report_tokens` command off-main            │
│    ├─ DispatchQueue.main.async for model mutation        │
│    └─ updates Workspace.tokenUsage (@Published)          │
└────────────────────────┬─────────────────────────────────┘
                         │  SwiftUI observation
                         ▼
┌──────────────────────────────────────────────────────────┐
│  TokenCostSidebarWidget (SwiftUI)                        │
│    ├─ observes TabManager.tabs[*].tokenUsage             │
│    ├─ shows aggregate total with .numericText() anim     │
│    ├─ expand/collapse per-workspace only when count > 1  │
│    └─ shows grayed $0.00 after agents finish (sticky)    │
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

### Socket command

```
report_tokens --cost=0.45 --input=50000 --output=10000 --cache-read=40000 --cache-write=5000 --model=claude-sonnet-4-20250514 [--tab=X]
```

### Extension implementation

```typescript
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
      sock.on("error", () => {}); // silently ignore
      sock.write(cmd + "\n");
      sock.end();
    } catch {
      // cmux may not be running
    }
  }

  pi.on("agent_turn_complete", async (_event, ctx) => {
    reportTokens(ctx);
  });
}
```

### Socket discovery

The extension finds the cmux socket via environment variables auto-set by cmux in spawned terminals:
1. **`CMUX_SOCKET_PATH`** (primary) — auto-set by cmux in terminal environments
2. **`CMUX_SOCKET`** (fallback alias)
3. **`/tmp/cmux.sock`** (default well-known path)

No well-known path scanning or CLI subprocess needed in Phase 1.

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
    var model: String?               // e.g. "claude-sonnet-4-20250514"
    var lastUpdated: Date = Date()

    var formattedCost: String {
        if cost < 0.01 {
            return String(format: "$%.4f", cost)
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

    /// Human-readable model name: strips date suffixes and common prefixes.
    var displayModelName: String? {
        guard let model, !model.isEmpty, model != "unknown" else { return nil }
        // "claude-sonnet-4-20250514" → "claude-sonnet-4"
        // "gpt-4o-2024-08-06" → "gpt-4o"
        let parts = model.split(separator: "-")
        // Drop trailing segment if it looks like a date (8 digits)
        if let last = parts.last, last.count == 8, last.allSatisfy(\.isNumber) {
            return parts.dropLast().joined(separator: "-")
        }
        return model
    }
}
```

### 3b. Add to `Workspace`

```swift
// In Sources/Workspace.swift, add to the Workspace class published properties:

@Published var tokenUsage: TokenUsageState?
```

Single property. No per-panel tracking, no computed aggregation. Add per-panel later if a real use case appears.

### 3c. Socket command — `report_tokens`

Add to `TerminalController.swift` command dispatch:

```swift
case "report_tokens":
    return handleReportTokens(args)
case "clear_tokens":
    return handleClearTokens(args)
```

Handler (follows socket command threading policy — parse off-main, minimal `main.async`):

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
    let model = parsed.options["model"]

    let state = TokenUsageState(
        input: input,
        output: output,
        cacheRead: cacheRead,
        cacheWrite: cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: cost,
        model: model,
        lastUpdated: Date()
    )

    let tabId = resolveTabId(parsed.options["tab"])

    DispatchQueue.main.async {
        guard let workspace = self.resolveWorkspace(tabId) else { return }
        workspace.tokenUsage = state
    }

    return "OK"
}

private func handleClearTokens(_ args: String) -> String {
    let parsed = parseArgs(args)
    let tabId = resolveTabId(parsed.options["tab"])

    DispatchQueue.main.async {
        guard let workspace = self.resolveWorkspace(tabId) else { return }
        workspace.tokenUsage = nil
    }

    return "OK"
}
```

Help text:

```
report_tokens --cost=<usd> [--input=N] [--output=N] [--cache-read=N] [--cache-write=N] [--model=<name>] [--tab=X] - Report token usage/cost
clear_tokens [--tab=X] - Clear token usage data
```

---

## 4. SwiftUI Widget — `TokenCostSidebarWidget`

### Location in sidebar

Inserted into `VerticalTabsSidebar` between the `GeometryReader` (tab scroll area) and the existing footer:

```swift
// In VerticalTabsSidebar body:
VStack(spacing: 0) {
    GeometryReader { proxy in
        // ... existing tab scroll view ...
    }

    // NEW: Token cost widget
    TokenCostSidebarWidget()

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

**Single workspace with data:**
```
┌─────────────────────────────┐
│  $0.42 · 105k tokens        │  ← compact single line
│  claude-sonnet-4             │  ← model name (secondary text)
└─────────────────────────────┘
```

**Multiple workspaces with data (collapsed, default):**
```
┌─────────────────────────────┐
│ 💲 $0.67 · 210k tokens   ▸  │  ← aggregate total + chevron
└─────────────────────────────┘
```

**Multiple workspaces with data (expanded):**
```
┌─────────────────────────────┐
│ 💲 $0.67 · 210k tokens   ▾  │
│   feature-work    $0.42     │
│   code-review     $0.25     │
└─────────────────────────────┘
```

**After agents finish (sticky $0.00 state):**
```
┌─────────────────────────────┐
│  $0.00                       │  ← grayed out, not hidden
└─────────────────────────────┘
```

### Implementation

```swift
// Sources/TokenCostSidebarWidget.swift (new file)

import SwiftUI

struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = false
    @State private var hasEverReportedTokens = false

    private var activeUsages: [(workspace: Workspace, usage: TokenUsageState)] {
        tabManager.tabs.compactMap { ws in
            guard let usage = ws.tokenUsage else { return nil }
            return (workspace: ws, usage: usage)
        }
    }

    private var totalCost: Double {
        activeUsages.reduce(0) { $0 + $1.usage.cost }
    }

    private var totalTokens: Int {
        activeUsages.reduce(0) { $0 + $1.usage.totalTokens }
    }

    private var shouldShow: Bool {
        !activeUsages.isEmpty || hasEverReportedTokens
    }

    private var showExpandControls: Bool {
        activeUsages.count > 1
    }

    var body: some View {
        if shouldShow {
            VStack(alignment: .leading, spacing: 4) {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(height: 1)

                if showExpandControls {
                    multiWorkspaceSummary
                } else {
                    singleWorkspaceSummary
                }

                if isExpanded && showExpandControls {
                    perWorkspaceBreakdown
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .onChange(of: activeUsages.count) { count in
                if count > 0 { hasEverReportedTokens = true }
            }
        }
    }

    // MARK: - Single workspace (no chevron, shows model name)

    private var singleWorkspaceSummary: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "dollarsign.circle")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(.secondary)
                Text(formattedTotalCost)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .animation(.default, value: totalCost)
                if totalTokens > 0 {
                    Text("·")
                        .foregroundColor(.secondary)
                    Text(formattedTotalTokens)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                }
            }
            .foregroundColor(activeUsages.isEmpty ? .secondary : .primary)

            if let model = activeUsages.first?.usage.displayModelName {
                Text(model)
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
            }
        }
    }

    // MARK: - Multi-workspace (chevron, expandable)

    private var multiWorkspaceSummary: some View {
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
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .animation(.default, value: totalCost)
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
    }

    private var perWorkspaceBreakdown: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(activeUsages, id: \.workspace.id) { item in
                HStack(spacing: 4) {
                    Text(item.workspace.title.prefix(20))
                        .font(.system(size: 10))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer()
                    if let model = item.usage.displayModelName {
                        Text(model)
                            .font(.system(size: 9))
                            .foregroundColor(.secondary.opacity(0.7))
                    }
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

    // MARK: - Formatting

    private var formattedTotalCost: String {
        if activeUsages.isEmpty { return "$0.00" }
        return TokenUsageState(cost: totalCost).formattedCost
    }

    private var formattedTotalTokens: String {
        TokenUsageState(totalTokens: totalTokens).formattedTokens
    }
}
```

### Sidebar height guard

If the sidebar height is too small (e.g., many tabs in a short window), the widget should hide gracefully. The `GeometryReader` in `VerticalTabsSidebar` already fills available space; the widget's intrinsic height (~30–60px) is subtracted from the scroll area. If this causes layout issues, add:

```swift
GeometryReader { proxy in
    // ...existing tab scroll...
}

if proxy.size.height > 200 { // min sidebar height threshold
    TokenCostSidebarWidget()
}
```

---

## 5. Implementation Phases

### Phase 1 — Ship it (single PR)

**Goal:** Working end-to-end: structured socket command, model, widget, pi extension.

| Step | File | Action |
|------|------|--------|
| 1 | `Sources/TokenUsage.swift` | **New** — `TokenUsageState` struct |
| 2 | `Sources/Workspace.swift` | **Edit** — add `@Published var tokenUsage: TokenUsageState?` |
| 3 | `Sources/TerminalController.swift` | **Edit** — add `report_tokens`, `clear_tokens` command handlers + help text |
| 4 | `Sources/TokenCostSidebarWidget.swift` | **New** — SwiftUI widget |
| 5 | `Sources/ContentView.swift` | **Edit** — insert widget into `VerticalTabsSidebar` body |
| 6 | `skills/token-reporter/cmux-token-reporter.ts` | **New** — pi extension |

**Effort:** ~5 hours

### Phase 2 — Polish & multi-agent (future)

Deferred until Phase 1 is validated end-to-end:

- Per-panel token tracking (`panelTokenUsage: [UUID: TokenUsageState]`)
- `list_tokens` socket command
- Session persistence for token stats (survive app restart)
- `CMUX_SOCKET` env var injection into spawned terminals
- Claude Code support (parse `~/.claude/projects/` cost data or hook `claude-hook`)
- Aider support (parse output for cost lines)
- Tooltip with full token breakdown (input / output / cache read / cache write)
- Cost alerts / budget thresholds (configurable via `@AppStorage`)
- Widget visibility toggle setting

---

## 6. File Manifest

| File | Action | Description |
|------|--------|-------------|
| `Sources/TokenUsage.swift` | **New** | `TokenUsageState` struct (Equatable, formatted cost/tokens/model) |
| `Sources/Workspace.swift` | **Edit** | Add single `@Published var tokenUsage: TokenUsageState?` |
| `Sources/TerminalController.swift` | **Edit** | Add `report_tokens` + `clear_tokens` commands |
| `Sources/ContentView.swift` | **Edit** | Insert `TokenCostSidebarWidget` into `VerticalTabsSidebar` |
| `Sources/TokenCostSidebarWidget.swift` | **New** | SwiftUI sidebar widget |
| `skills/token-reporter/cmux-token-reporter.ts` | **New** | Pi extension for token reporting |
| `tests/test_token_reporting.py` | **New** | Socket command tests |

---

## 7. Testing Strategy

### Socket command tests (highest priority)

Add `tests/test_token_reporting.py` following the `test_ctrl_socket.py` pattern. Run on the VM:

```python
def test_report_tokens_basic():
    """report_tokens stores structured data and returns OK"""
    result = send_socket("report_tokens --cost=0.42 --input=50000 --output=10000")
    assert result == "OK"

def test_report_tokens_missing_cost():
    """report_tokens without --cost returns error"""
    result = send_socket("report_tokens --input=50000")
    assert "ERROR" in result

def test_report_tokens_with_model():
    """report_tokens with --model stores model name"""
    result = send_socket("report_tokens --cost=0.42 --input=50000 --output=10000 --model=claude-sonnet-4-20250514")
    assert result == "OK"

def test_clear_tokens():
    """clear_tokens resets token state"""
    send_socket("report_tokens --cost=0.42 --input=50000 --output=10000")
    result = send_socket("clear_tokens")
    assert result == "OK"
```

Run via:
```bash
ssh cmux-vm '... && python3 tests/test_token_reporting.py'
```

### Integration test

Manual, with a tagged Debug build:

```bash
./scripts/reload.sh --tag token-cost
# In another terminal:
tail -f /tmp/cmux-debug-token-cost.log | grep token
# Start pi in a cmux pane, make queries, verify widget updates
```

### What NOT to test

- SwiftUI widget rendering (too simple; visual check during debug build)
- Per-panel aggregation (not building it)
- Session persistence (deferred)
- Multi-agent scenarios (deferred)

---

## 8. Compatibility & Policy Compliance

### Threading policy

- `report_tokens` is a telemetry command: parse/validate off-main, `DispatchQueue.main.async` only for the `@Published` mutation.
- No `DispatchQueue.main.sync` anywhere on the hot path.

### Socket focus policy

- `report_tokens` and `clear_tokens` are pure data commands — no app activation, no window raising, no focus mutation.

### SwiftUI diffing

- `TokenUsageState` conforms to `Equatable` — SwiftUI skips re-renders when the value hasn't changed.
- Extension debounces at $0.001 delta — prevents unnecessary socket traffic.
- Single `@Published` property (not per-panel dictionary) — minimal observation overhead.

---

## 9. Resolved Questions

| Question | Decision |
|----------|----------|
| Skip Phase 1 (`report_meta`)? | **Yes.** Throwaway work with zero reuse. |
| Per-panel tracking? | **No for v1.** Agents report per-session. Add later if needed. |
| `AgentType` enum? | **No.** Use `--model=` string instead. Model name is more useful. |
| Extension uses `nc -U`? | **No.** Use Node `net.connect()` directly. No shell escaping, no subprocess. |
| Widget visibility when no data? | **Sticky.** Show grayed `$0.00` after first report, don't disappear. |
| Expand/collapse always? | **Only when `activeUsages.count > 1`.** Single workspace = no chevron. |
| Cost-per-minute rate? | **No.** Noisy, anxiety-inducing, not actionable. |
| Currency? | **USD always.** All LLM providers price in USD. |
| Cost animation? | **Yes.** `.contentTransition(.numericText())` on macOS 14+. |
| Sidebar min-height guard? | **Yes.** Hide widget if sidebar height < 200px. |
