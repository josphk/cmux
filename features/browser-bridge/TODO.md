# Browser Bridge — Progress

See `PLAN.md` for full design. See `REVIEW.md` for edge cases and testing matrix.

## Setup
- [ ] Switch to `--tag dev` as working session
- [ ] Create feature branch: `git checkout -b feature/browser-bridge`

## Phase 1+2: Inspection Mode + JS Injection
Tag: `--tag bridge-overlay`

- [ ] Add `isInspectionModeActive`, `inspectionPickCount` state to `BrowserPanel.swift`
- [ ] Register `WKScriptMessageHandler` for `cmuxInspect`
- [ ] Add `enableInspectionMode()` / `disableInspectionMode()` / `toggleInspectionMode()`
- [ ] Add navigation guard in `didCommitNavigation` to auto-cancel
- [ ] Write JS injection script (overlay, tooltip, crosshair, click intercept)
- [ ] JS posts element data via `window.webkit.messageHandlers.cmuxInspect.postMessage()`
- [ ] JS stays in inspection mode after click (green flash, resume)
- [ ] Write JSONL bridge file on each pick (atomic append)
- [ ] Guard: no inspection on new-tab page
- [ ] Test: hover highlight, tooltip, multi-pick, navigation cancel

## Phase 3: Toolbar Button + Banner
Tag: `--tag bridge-toolbar`

- [ ] Add 🎯 scope button to browser toolbar (right side)
- [ ] Button toggles inspection mode, shows active state
- [ ] Add inspection banner with pick count between chrome bar and web content
- [ ] Disabled on new-tab page
- [ ] Test: button toggle, banner appears/disappears, pick count updates

## Phase 4: Keyboard Shortcut
Tag: `--tag bridge-shortcut`

- [ ] Add Cmd+Shift+I handler in `AppDelegate.swift`
- [ ] Only activates when browser panel is focused
- [ ] Test: shortcut toggles, no-op in terminal, no conflicts

## Phase 5: Socket/CLI Command
Tag: `--tag bridge-socket`

- [ ] Add `browser.inspect` route in `TerminalController.swift`
- [ ] Enable on main (async), poll JSONL off-main for `--wait`
- [ ] Add `cmux browser inspect [--wait]` CLI
- [ ] `--wait` returns all picked elements as JSON when inspection ends
- [ ] Test: non-blocking enable, blocking wait, timeout, concurrent commands

## Phase 6: Pi Extension
Tag: `--tag bridge-e2e`

- [ ] Create `~/.pi/agent/extensions/browser-bridge/index.ts`
- [ ] `fs.watch` bridge dir + 2s polling fallback
- [ ] Each new JSONL line → `pi.sendMessage()` with `customType: "browser-element"`
- [ ] `registerMessageRenderer` for browser-element messages (🎯 prefix)
- [ ] `registerTool("browser_inspect")` — agent-initiated flow
- [ ] `registerCommand("/inspect")` — manual trigger
- [ ] Test: multi-pick → elements appear in pi chat, agent tool flow, outside-cmux no-op
