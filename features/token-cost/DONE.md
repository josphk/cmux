# Token Cost Sidebar Widget — DONE

**Branch:** `feature/token-cost`  
**PR:** https://github.com/josphk/cmux/pull/3  
**Completed:** 2026-03-01  

## What We Built

A live token usage and cost widget in the cmux sidebar that tracks every coding agent running in the window. Each agent (pane) gets its own line item with real-time cost updates, active/dead status, and click-to-focus navigation.

### Key Features

- **Per-agent tracking** keyed by surface/pane ID — multiple agents in splits or across workspaces each track independently
- **Live cost updates** via `cmux report-tokens` CLI command (auto-resolves workspace + surface from env)
- **Active/dead lifecycle**: green dot = running, gray outline = exited. Dead agents preserved for accounting, dismissible via X button on hover
- **Cost accumulation** across agent sessions in the same pane (quit at $0.50, restart, accrue $1.00 → shows $1.50)
- **Sorted display**: active agents first (highest cost → lowest), then dead agents (same order)
- **Expand/collapse** with smooth clipped-height animation, collapsed by default, user-driven
- **Click to focus** an active agent's pane from the widget
- **Agent count badge** in the header

### CLI Commands Added

```
cmux report-tokens --cost <usd> [--input N] [--output N] [--model name]
cmux deactivate-tokens
cmux clear-tokens [--surface id] [--workspace id]
```

### Pi Extension

`skills/token-reporter/cmux-token-reporter.ts` — reports cumulative session cost on `agent_end`, deactivates on `session_shutdown`.

## Learnings

### Build Workflow
- **Always use `reload.sh --tag X`**, never raw `xcodebuild` + manual launch. The tagged app is a copy — `xcodebuild` alone builds to `cmux DEV.app` but the tagged `cmux DEV <tag>.app` keeps the stale binary. Wasted significant debugging time on this.
- **Socket testing from external terminals** requires patching `CMUX_SOCKET_MODE=allowAll` into Info.plist + re-codesigning.

### SwiftUI Observation
- **Nested `@Published` doesn't propagate.** `TabManager.tabs[*].tokenUsageByAgent` changes don't trigger widget re-renders. Fix: generation counter (`@Published var tokenUsageGeneration`) on TabManager, bumped on every mutation, read in the widget body.
- **`GeometryReader` is greedy in VStack** — squeezes siblings to zero height. Fix: `.fixedSize(horizontal: false, vertical: true)`.
- **`Button` with `.plain` style ignores `contentShape`** — hit area is only opaque content. Fix: replace with `onTapGesture` + `contentShape(Rectangle())`.
- **`.clipped()` only clips visually**, hidden views still receive taps. Fix: `.allowsHitTesting(isExpanded)`.
- **Container animations propagate to children** — hover effects on rows fired during expand/collapse when the cursor was positioned where rows would appear. Fix: suppress hover for the duration of the animation.

### Pi Extension
- **`getBranch()` returns session entries, not raw messages.** Usage is at `entry.message.usage`, not `entry.usage`. The session entry envelope is `{ type: "message", message: { role, usage, ... } }`.
- **`agent_turn_complete` doesn't exist** — the correct event is `agent_end`.
- **`session_shutdown` handlers must be synchronous.** Pi exits immediately after handlers return. Async `execFile`/`createConnection` won't complete. Fix: `execFileSync` with `spawnSync("nc")` fallback.
- **`cmux` binary on PATH may differ across tagged builds.** CLI calls can silently fail. Always include a direct socket fallback.

### Data Model
- **Surface ID = panel UUID.** `CMUX_SURFACE_ID` (set in GhosttyTerminalView) matches `panelId.uuidString` used in `didCloseTab`. Both are uppercase UUID strings.
- **Cost carry-forward needs careful offset tracking.** Active agents preserve `costOffset` across updates. Reactivating a dead agent snapshots `effectiveCost` as the new offset. Cleared (X'd) entries are fully removed — new agents in that pane start fresh.

## Files

| File | Purpose |
|------|---------|
| `Sources/TokenUsage.swift` | `TokenUsageState` struct + notification name |
| `Sources/TokenCostSidebarWidget.swift` | SwiftUI widget: header, per-agent rows, hover/click |
| `Sources/Workspace.swift` | `tokenUsageByAgent` dictionary, pane close deactivation |
| `Sources/TabManager.swift` | `tokenUsageGeneration` counter, notification observer |
| `Sources/TerminalController.swift` | `report_tokens`, `clear_tokens`, `deactivate_tokens` handlers |
| `Sources/ContentView.swift` | Widget insertion in sidebar |
| `CLI/cmux.swift` | CLI commands + help text |
| `skills/token-reporter/cmux-token-reporter.ts` | Pi extension |
