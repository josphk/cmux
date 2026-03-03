# Browser Bridge — Parallelized Work Plan

## Overview

Click elements in the cmux browser → auto-reference them in pi agent chat.
See `features/browser-bridge/PLAN.md` for full design.

## Dependency Graph

```
Stream A: JS Script ──────────┐
  (standalone, no deps)       │
                              ├──► Phase 1+2: BrowserPanel.swift (coordinator)
Stream B: Pi Extension ───────┤     embeds JS, wires handler + bridge file
  (TypeScript, no Swift deps) │
                              │
Stream C: Socket/CLI ─────────┘
  (TerminalController.swift     depends on BrowserPanel interface contract:
   + CLI/cmux.swift)              enableInspectionMode(), disableInspectionMode(),
                                  isInspectionModeActive, bridgeFileURL, inspectionSurfaceId)
```

After Streams A/B/C complete independently:
- **Coordinator** embeds JS into BrowserPanel, wires WKScriptMessageHandler + bridge file
- **Coordinator** adds toolbar button + banner (BrowserPanelView.swift)
- **Coordinator** adds Cmd+Shift+I shortcut (AppDelegate.swift)
- **Coordinator** reviews all work, integrates, tests with `./scripts/reload.sh --tag bridge`

## Stream A: JavaScript Injection Script

**Agent task:** Write the standalone inspection mode JS.
**Output:** `features/browser-bridge/inspection-mode.js`
**No Swift/project deps** — pure browser JS, testable in any dev console.

Requirements:
- Hover overlay (position:fixed blue rect tracking getBoundingClientRect)
- Tooltip below element showing `role: "label text"`
- Crosshair cursor via injected `<style>`
- Click intercept (preventDefault + stopImmediatePropagation on capture phase)
- Posts element data via `window.webkit.messageHandlers.cmuxInspect.postMessage(data)`
- Multi-pick: stays in inspection mode after click, brief green flash (200ms)
- `window.__cmuxInspectCleanup()` removes all injected DOM/listeners
- Selector generation: prefer [data-testid] > #id > shortest tag[attr], max 3 ancestors
- Role detection: role attr → infer from tag+type (button, link, textbox, checkbox, radio, combobox, img, heading)
- Label: aria-label → aria-labelledby → textContent (truncated 80 chars)
- iframe hover: tooltip shows "iframe — inner elements not supported"
- Element data shape: `{ selector, text, role, tagName, attributes, url, pageTitle }`

## Stream B: Pi Extension

**Agent task:** Write the browser-bridge pi extension.
**Output:** `features/browser-bridge/extension/index.ts`
**No Swift deps** — reads JSONL bridge files from `/tmp/cmux-bridge/<surface-id>.jsonl`.

Requirements:
- Only activates when `CMUX_WORKSPACE_ID` env var is set
- Watches `/tmp/cmux-bridge/` dir for .jsonl files (fs.watch + 2s polling fallback)
- Each new JSONL line → `pi.sendMessage()` with formatted element reference
- Format: `<browser-element selector="..." role="..." text="..." page="..." />`
- `registerTool("browser_inspect")` — runs `cmux browser inspect --wait`, returns picked elements
- `registerCommand("/inspect")` — toggles inspection mode, shows notification
- Graceful no-op outside cmux

Bridge file JSONL line format (one per pick):
```json
{"selector":"...","text":"...","role":"...","tagName":"...","attributes":{...},"url":"...","pageTitle":"...","timestamp":"...","surface_id":"...","pick_index":1,"event_id":"uuid"}
```

Reference: `features/browser-bridge/PLAN.md` Phase 6 for full spec.
Reference pi extension API: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/`

## Stream C: Socket/CLI Command

**Agent task:** Add `browser.inspect` socket command and `cmux browser inspect` CLI.
**Output:** Patches to `Sources/TerminalController.swift` and `CLI/cmux.swift`.

Requirements for TerminalController.swift:
- Add route `"browser.inspect"` in V2 handler switch
- Implementation: enable inspection on main (async), poll bridge file off-main for `--wait`
- Params: `wait` (bool), `timeout_ms` (int, default 30000)
- Non-wait: returns `{"status":"enabled"}` immediately
- Wait: polls bridge JSONL file every 200ms until inspection ends or timeout
- On timeout: disable inspection, return whatever was picked
- Read all picks from JSONL with `readAllPicks(from:)` helper
- **CRITICAL:** Do NOT use DispatchQueue.main.sync for the wait loop — deadlock

Requirements for CLI/cmux.swift:
- Add `inspect` subcommand under browser commands
- `cmux browser inspect` — enable inspection (non-blocking)
- `cmux browser inspect --wait` — wait for picks, print JSON result
- `cmux browser inspect --wait --timeout-ms 30000`

Interface contract (will exist on BrowserPanel):
```swift
var isInspectionModeActive: Bool { get }
var inspectionSurfaceId: String { get set }
func enableInspectionMode()
func disableInspectionMode()
var bridgeFileURL: URL { get }
```

## Coordinator Tasks (after streams complete)

- [ ] Embed JS from Stream A as `static let inspectionModeScript` in BrowserPanel.swift
- [ ] Add `isInspectionModeActive`, `inspectionPickCount`, `inspectionSurfaceId` state
- [ ] Register WKScriptMessageHandler for "cmuxInspect" in webView config
- [ ] Implement handleInspectedElement() → JSONL bridge file write
- [ ] Add navigation guard in didCommitNavigation
- [ ] Add toolbar button in BrowserPanelView.swift
- [ ] Add inspection banner with pick count
- [ ] Add Cmd+Shift+I shortcut in AppDelegate.swift
- [ ] Integrate Stream C socket/CLI changes
- [ ] Install Stream B extension to ~/.pi/agent/extensions/browser-bridge/
- [ ] Test end-to-end: `./scripts/reload.sh --tag bridge`
