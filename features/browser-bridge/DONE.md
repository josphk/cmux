# Browser Bridge — DONE

**Branch:** `browser-bridge`  
**Completed:** 2026-03-02  

## What We Built

A browser-to-agent bridge that lets you click elements in the cmux browser panel and reference them in your pi agent conversation. Pick elements visually, get structured data as context, and reference specific picks by ID in your prompt.

### Key Features

- **Pick Mode** — toggle via toolbar scope button or ⌘⇧I. Crosshair cursor, blue highlight overlay, tooltip showing role/label on hover
- **Multi-pick** — stay in pick mode after each click (green flash feedback), ESC/button/shortcut to exit
- **Numbered pick IDs** — each pick gets `<1>`, `<2>`, `<3>` etc., auto-appended to the editor
- **Selective context injection** — only picks referenced as `<N>` in the user's prompt are sent to the LLM. Unreferenced picks (deleted from editor) are silently dropped
- **Picks widget** — styled blue boxes below the editor showing all pending picks with truncation
- **Status indicator** — "● Ready for browser picks" widget between editor and footer, only visible when pick mode is active and the agent is the target
- **Dynamic target resolution** — picks go to the most recently focused terminal with an active pi agent, resolved per-pick not locked at session start
- **Workspace-scoped** — indicator only shows on agents in the same workspace as the inspecting browser, not agents in other workspaces
- **Flow B (agent-initiated)** — `browser_inspect` tool the LLM can call to request the user pick elements, with `--wait` mode and timeout
- **`/inspect` command** — toggle inspection from the pi prompt

### Architecture

```
Browser (WKWebView)
  ↓ JS injection (inline Swift string)
  ↓ WKScriptMessageHandler
BrowserPanel.swift
  ↓ resolveTargetTerminal() → lastFocusedTerminalPanelId
  ↓ JSONL append to /tmp/cmux-browser-bridge/<surfaceId>.jsonl
Pi Extension (cmux-browser-inspect.ts)
  ↓ fs.watch on bridge directory
  ↓ pendingPicks map + updateBelowEditorWidgets()
  ↓ before_agent_start → inject only referenced picks
Agent LLM context
```

### Bridge Protocol

Files in `/tmp/cmux-browser-bridge/`:
- `<surfaceId>.listening` — presence marker written by pi extension (PID)
- `<surfaceId>.jsonl` — pick data written by cmux, one JSON object per line
- `inspecting` — marker file, exists only while pick mode is active
- `active-target` — `workspaceId:surfaceId` format, written on terminal focus change (only during inspection)

### CLI Commands Added

```
cmux browser inspect [--wait] [--timeout-ms N]
```

## Learnings

### JS Injection
- **Inline JS into Swift multiline strings.** File loading via `#filePath`, relative paths, and bundle resources all broke across debug/release/tagged builds. Three bugs before we gave up and inlined. The JS is ~160 lines compressed — not worth the indirection.
- **`var` → `const`/`let`** in the injected JS is a free safety improvement. The IIFE scope protects against globals but `const`/`let` catches accidental reassignment.
- **Double-injection guard** (`window.__cmuxInspectActive`) is essential — `evaluateJavaScript` can be called multiple times on the same page.

### Pi Extension Lifecycle
- **`/reload` creates zombie watchers.** When pi reloads extensions, old `fs.watch` and `setInterval` callbacks survive. Both old and new instances process the same pick. Fix: delete the bridge file on init — old instance's `linesRead` exceeds the new file's line count, so it silently skips.
- **`sendMessage` with `triggerTurn: false`** adds custom messages to the session that go to the LLM as user-role context. There's no way to selectively remove them. For picks that should be optional context, store in memory and inject via `before_agent_start` return value instead.
- **`appendEntry` is not rendered** in the chat UI — it's for state persistence only. Use `sendMessage` for visual display or `setWidget` for ephemeral display.
- **`setWidget` component factories** must truncate lines to terminal width. Pi crashes with `Error: Rendered line exceeds terminal width` if you don't. Use `visibleWidth()` accounting for ANSI escapes.
- **Map insertion order** controls widget stacking. Multiple `belowEditor` widgets stack in Map insertion order. Clear and re-set both widgets to control which appears first.
- **`setStatus`** goes on its own footer line (line 3), not inline with the cwd. It's the extension status area, always below token stats.

### Swift/AppKit
- **`#filePath`** resolves at compile time but the path is baked into the binary as a string literal. Works for development but breaks if the source tree moves.
- **`nonisolated(unsafe)` static let** with a closure — can't access `@MainActor` properties from `deinit`. For cleanup of global files shared across panels, use `disableInspectionMode()` explicitly rather than deinit.
- **`ISO8601DateFormatter` allocation** is measurable per-pick. Use a static instance.
- **`line.data(using: .utf8)!`** — force unwrap on UTF-8 encoding. Always safe in practice but guard-let is cleaner.
- **⌘⌥I conflicts with browser devtools toggle.** Use ⌘⇧I instead. Match with `event.keyCode == 34` for Option combos since the character changes.
- **Keyboard shortcuts need workspace-wide panel search.** `focusedBrowserPanel` only works when the browser pane has focus. Search `selectedTab?.panels` to find the browser from any pane.

### Bridge Design
- **Workspace-scoped `active-target`** prevents indicator bleed. Format: `workspaceId:surfaceId`. Without the workspace ID, opening a terminal in a different workspace while pick mode is active shows the indicator on the wrong agent.
- **Guard `active-target` writes** on inspection being active. Without this, every terminal focus change writes to disk even when no one is inspecting.
- **Wait mode stale picks** — `readAllInspectionPicks` must skip pre-existing JSONL lines. Record line count before enabling inspection, pass as `skipLines` parameter.
- **`connectedSurfaceIds` (in-memory Set)** is faster than filesystem checks for `resolveTargetTerminal()`. BrowserBridgeWatcher already maintains this via kqueue.

## Files

| File | Purpose |
|------|---------|
| `Sources/Panels/BrowserPanel.swift` | Inline JS, `resolveTargetTerminal()`, `enableInspectionMode()`, `handleInspectedElement()`, JSONL write |
| `Sources/Panels/BrowserPanelView.swift` | Scope button (disabled state, tooltip), pick mode banner |
| `Sources/Panels/BrowserBridgeWatcher.swift` | kqueue singleton watching `/tmp/cmux-browser-bridge/`, `connectedSurfaceIds`, `setActiveTarget()` |
| `Sources/Workspace.swift` | `lastFocusedTerminalPanelId`, writes `active-target` on focus (guarded) |
| `Sources/TabManager.swift` | Updates bridge target on workspace switch |
| `Sources/AppDelegate.swift` | ⌘⇧I shortcut handler (workspace-wide browser search) |
| `Sources/TerminalController.swift` | `browser.inspect` socket route, wait mode with skip-lines |
| `CLI/cmux.swift` | `browser inspect` CLI command |
| `features/browser-bridge/extension/cmux-browser-inspect.ts` | Pi extension: watcher, numbered picks, widget, `before_agent_start` filtering |
| `features/browser-bridge/inspection-mode.js` | Reference JS file (inlined into Swift, kept for editing) |
