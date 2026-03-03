# Browser Bridge — DONE

**Branch:** `browser-bridge`  
**Completed:** 2026-03-02  

## What We Built

A browser-to-agent bridge that lets you click elements in the cmux browser panel and reference them in your pi agent conversation. Pick elements visually, get structured data as context, and reference specific picks by ID in your prompt.

### Key Features

- **Pick Mode** — toggle via toolbar scope button or ⌘⇧I. Crosshair cursor, blue highlight overlay, tooltip showing role/label on hover
- **Multi-pick** — stay in pick mode after each click (green flash feedback), ESC/button/shortcut to exit
- **Numbered pick IDs** — each pick gets `❮1❯`, `❮2❯`, `❮3❯` etc., auto-appended to the editor (Unicode heavy angle brackets to avoid collisions with user text)
- **Selective context injection** — only picks referenced as `❮N❯` in the user's prompt are sent to the LLM. Unreferenced picks (deleted from editor) are silently dropped
- **Picks widget** — styled blue boxes below the editor showing all pending picks with truncation
- **Status indicator** — "● Ready for browser picks" widget between editor and footer, only visible when pick mode is active and the agent is the target
- **Dynamic target resolution** — picks go to the most recently focused terminal with an active pi agent, resolved per-pick not locked at session start
- **Workspace-scoped** — indicator only shows on agents in the same workspace as the inspecting browser, not agents in other workspaces
- **Flow B (agent-initiated)** — `browser_inspect` tool the LLM can call to request the user pick elements, with `--wait` mode and timeout
- **`/inspect` command** — toggle inspection from the pi prompt

## How It Works

The browser bridge connects three layers: the browser page, the cmux app, and the pi agent. Each layer has a single responsibility and they communicate through simple, ephemeral files.

### The browser side

When the user enters pick mode, cmux injects a small JavaScript script into the browser page. This script adds a crosshair cursor, draws a blue highlight overlay as the user moves their mouse over elements, and shows a tooltip with the element's role and label. When the user clicks, the script extracts structured data about the element — its CSS selector, text content, ARIA role, tag name, and relevant attributes — and posts it back to Swift via WebKit's native message handler bridge. The user stays in pick mode and can click more elements. A green flash confirms each pick.

### The cmux app side

When cmux receives a pick from the browser, it figures out which terminal should get it. It checks which terminal was most recently focused and whether that terminal has an active pi agent (known via presence marker files that each agent writes on startup). Once it finds the right target, it appends the pick data as a JSON line to a bridge file scoped to that terminal's surface ID. This is the entire handoff — a single file append.

cmux also manages the coordination signals: an `inspecting` marker file that exists only while pick mode is active, and an `active-target` file that tracks which terminal in which workspace is the current target. These are written on inspection toggle and terminal focus changes, and cleaned up when inspection ends.

### The pi extension side

Each pi agent runs a file system watcher on the bridge directory. When it sees new lines in its own bridge file, it parses them, assigns incrementing pick IDs (`❮1❯`, `❮2❯`, ...), stores them in memory, shows them in a styled widget below the editor, and auto-appends the ID reference to the editor text.

The key design decision: picks are **not sent to the LLM immediately**. They're held in memory until the user submits their message. At that point, the extension scans the prompt for `❮N❯` references and injects only the referenced picks as context. If the user deleted `❮1❯` from their prompt, that pick's data never reaches the model. This keeps context lean and gives the user full control over what the agent sees.

The extension also watches the `inspecting` and `active-target` files to show a status indicator ("● Ready for browser picks") only on the agent that will actually receive picks, and only while pick mode is active.

### Architecture diagram

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
  ↓ before_agent_start → scan for ❮N❯ refs → inject only referenced picks
Agent LLM context
```

### Bridge files

All bridge state lives in `/tmp/cmux-browser-bridge/`. Nothing is persistent — files are ephemeral transport cleaned up when inspection ends or agents disconnect.

- `<surfaceId>.listening` — presence marker written by pi extension on startup, removed on shutdown
- `<surfaceId>.jsonl` — pick data, one JSON object per line, appended by cmux, read by extension
- `inspecting` — exists only while pick mode is active
- `active-target` — `workspaceId:surfaceId`, written on terminal focus change during inspection

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
- **`/reload` creates zombie watchers.** When pi reloads extensions, old `fs.watch` and `setInterval` callbacks survive in the Node.js event loop. Both old and new instances process the same pick. Two-layer fix: (1) delete the bridge file on init — old instance's `linesRead` exceeds the new file's line count, so it silently skips. (2) Close existing watchers/intervals at the top of `startWatching()` before creating new ones — prevents accumulation within the current instance from module-level init + `session_start`.
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

### Pi TUI Widget/Editor Corruption
- **`setWidget()` corrupts `getEditorText()`.** Calling `setWidget` triggers a TUI re-render. Widget content (which includes pick references like `❮1❯`) bleeds into the terminal buffer region occupied by the editor. Subsequent `getEditorText()` calls read the corrupted buffer, returning the real editor text plus phantom pick IDs that leaked from the widget. A read-modify-write cycle (`getEditorText` → append → `setEditorText`) amplifies the corruption on every pick.
- **Phantom IDs always reference the next pick number** because the widget just rendered the latest pick entry and that content is what bleeds into the editor buffer. The number of phantom duplicates scales with widget size.
- **The corruption is in the terminal buffer, not the data model.** Immediately after `setEditorText("❮1❯")`, `getEditorText()` returns the correct text. But after a `setWidget` call triggers a re-render, the next `getEditorText()` returns corrupted text.
- **Fix: `cleanEditorText()` strips phantom `❮N❯` refs where N is not in `pendingPicks`.** Called BEFORE adding the new pick to `pendingPicks` so the incoming ID is also caught if it appears as corruption. This is a clean invariant — any `❮N❯` for a pick that doesn't exist yet is guaranteed phantom.
- **Use Unicode delimiters (`❮❯`) instead of ASCII (`<>`).** The `cleanEditorText` sanitizer strips unrecognized `❮N❯` patterns, which would collide with user-typed `<N>` in prompts (e.g., "set font size to <14>"). Heavy angle brackets `❮❯` (U+276E/U+276F) are never accidentally typed, eliminating false positives entirely.
- **Dedup referenced IDs in `before_agent_start`.** The prompt regex finds ALL `❮N❯` matches including duplicates from any residual corruption. A `seen` Set ensures each pick is injected only once.

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
