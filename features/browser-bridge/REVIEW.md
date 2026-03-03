# Browser Bridge Plan — Review

## 1. Edge Cases the Plan Misses

### 1a. 🔴 CRITICAL: `--wait` deadlock freezes the entire app

`v2BrowserWithPanel` calls `v2MainSync` → `DispatchQueue.main.sync`. The `--wait` implementation then enters a `while Date() < deadline { Thread.sleep(0.2) }` loop **inside** that closure. This blocks the main thread for up to 30 seconds. The entire app is frozen — no UI rendering, no click handling. The user literally cannot click an element to satisfy the wait. Every other socket command is also blocked.

**Fix:** Split into two phases. Enable inspection mode via `v2MainSync` (fast, returns immediately). Then poll the bridge file **off-main** in the socket handler thread. The main-thread work should be a quick `enableInspectionMode()` call; the blocking wait happens on the socket worker.

### 1b. 🔴 Page navigation destroys injected JS — inspection mode becomes a zombie

If the user enables the picker, then the page navigates (link click, redirect, SPA route change), all injected JS is destroyed. But `isInspectionModeActive` stays `true`, the polling timer keeps firing against `undefined`, and the banner still says "click any element." Nothing works.

**Fix:** Hook `webView(_:didCommitNavigation:)` / `webView(_:didFinishNavigation:)` in the navigation delegate. Either re-inject the inspection script or call `disableInspectionMode()` with a user-facing notification ("Inspection cancelled — page navigated").

### 1c. 🟡 Bridge file keyed by workspaceId — ambiguous with multiple browser splits

A workspace can have multiple browser panels. The bridge file is keyed by `workspaceId`, so if two browser splits exist in the same workspace, they clobber each other's bridge files. The socket command resolves whichever panel is *focused*, which may differ from the panel the user clicked the picker button in.

**Fix:** Key the bridge file by `surfaceId` (the panel's own UUID), not `workspaceId`. Pass `surface_id` explicitly through the CLI/socket flow.

### 1d. 🟡 No atomic file write — pi extension may read partial JSON

`jsonData.write(to: bridgeFile)` is not atomic. The pi extension's `fs.watch` fires on any file system event, including partial writes. `JSON.parse` on a half-written file throws, silently dropping the pick event.

**Fix:** Write to a `.tmp` file, then `rename` to the final path. POSIX rename is atomic.

### 1e. 🟡 Rapid double-click / duplicate events

The extension deduplicates by timestamp string equality. Two clicks in the same second → second click is silently dropped. Two clicks in different seconds → both fire, potentially double-pasting.

**Fix:** Use a monotonic counter or UUID per pick event instead of (or in addition to) timestamp. Have the extension consume-then-delete atomically.

### 1f. 🟡 iframes — confusing silent failure

Many real pages use iframes (OAuth, Stripe, embedded widgets). The injected JS only applies to the top-level document. Hovering over an iframe shows the `<iframe>` wrapper element, not its contents. Users will try to pick inner elements and be confused.

**Fix (minimal):** Detect when the hovered element is an `<iframe>` and show a tooltip like "iframe — inner elements not yet supported." Prevents silent confusion.

### 1g. 🟡 New-tab page / about:blank

If the user clicks the picker button while on the new-tab page, JS injection may fail or return nonsensical results. The plan doesn't guard for `isShowingNewTabPage`.

**Fix:** Guard `enableInspectionMode()` — `guard !isShowingNewTabPage else { /* show brief notification */ return }`.

### 1h. 🟢 Stale bridge file on crash/force-quit

If cmux crashes, stale `/tmp/cmux-bridge/<uuid>.json` files linger. Next launch, the pi extension's `fs.watch` could process a stale pick.

**Fix:** Include a `pid` field in the bridge JSON. On extension start, validate PID is alive. Or enforce a staleness threshold (ignore files >10s old).


## 2. UX Improvements

### 2a. No visual confirmation after pick

After clicking an element, the overlay vanishes instantly. The user has no idea if it worked until they switch to the terminal and see the paste.

**Improvement:** Add a brief 200ms "flash" animation on the clicked element (green border pulse), then dismiss. This gives tactile feedback before the reference appears in the editor.

### 2b. No inline preview of what was captured

The user has to switch context to the terminal to verify the pick was correct.

**Improvement:** Show a transient 3-second toast in the browser chrome near the picker button: `✓ button "Submit Form" — form > button.primary-submit`. Auto-dismiss.

### 2c. Single-pick-then-exit is friction-heavy

The plan exits inspection mode after one click. If the user picked the wrong element, they re-click the button, re-enter mode, re-pick.

**Improvement:** After a pick, stay in inspection mode. Banner updates to "Element captured. Click another or press ESC to finish." This is especially important for Flow B where the agent asked for a specific element — misclicks shouldn't require re-invoking the tool.

### 2d. `/inspect` command is redundant with the toolbar button

For Flow A the toolbar button is the natural entry point. `/inspect` duplicates it.

**Improvement:** Make `/inspect` accept an optional message: `/inspect "click the login button"` — which enables inspection mode AND prepends that instruction to the pasted reference. This makes it a distinct, useful command.

### 2e. Keyboard shortcut not discoverable

Cmd+Shift+I is only in the tooltip. No menu bar entry.

**Improvement:** Add a menu bar item under a "Browser" menu: `Pick Element ⌘⇧I`. macOS users expect shortcuts in menus. Also show the shortcut in the inspection banner.

### 2f. Formatted reference is opaque

`[browser-element: button "Submit Form" | selector: form > button.primary-submit | ...]` is hard to read for both human and LLM.

**Improvement:** Use a more structured format:
```
<browser-element selector="form > button.primary-submit" role="button" text="Submit Form" page="http://localhost:3000/login" />
```
XML-like tags are well-understood by LLMs and easy to grep for.


## 3. Simplification Opportunities

### 3a. 🔵 Use `WKScriptMessageHandler` now, not "future"

The plan lists this as a future enhancement, but the codebase already uses `addUserScript` (BrowserPanel.swift:1413). A message handler eliminates:
- The 150ms polling timer
- The `window.__cmuxInspectedElement` global variable
- The poll→parse→check-null→re-poll cycle
- Timing bugs where the poll misses a quick click-then-navigate

Replace with:
```swift
config.userContentController.add(self, name: "cmuxInspect")
```
And in JS: `window.webkit.messageHandlers.cmuxInspect.postMessage(elementData)`.

This is ~15 lines of code vs ~40, zero latency, and synchronous.

### 3b. 🔵 Eliminate the bridge file for Flow A (or at minimum, atomic-write it)

The architecture: Swift writes JSON → pi extension watches file → pastes to editor. The intermediate file adds complexity (atomic writes, cleanup, staleness, `fs.watch` unreliability, path coordination).

**Simpler alternative:** Use the cmux socket directly. After the element is picked, have Swift emit a socket event/notification that the pi extension subscribes to. The codebase already has notification infrastructure.

If keeping the bridge file: use atomic write (write `.tmp`, `rename`).

### 3c. 🔵 Collapse Phases 1 + 3

Phase 1 (state + lifecycle) and Phase 3 (polling + bridge file) are tightly coupled — you can't test Phase 1 without Phase 3. The polling timer starts in `enableInspectionMode()` from Phase 1 but is defined in Phase 3. Merging avoids a broken intermediate state.

### 3d. 🔵 Simplify selector generation

Robust unique CSS selectors are a rabbit hole (CSS-in-JS dynamic classes, minified names, deep nesting). The LLM doesn't need a perfect CSS selector — it needs to *identify* the element.

**Simplify:** Prefer `[data-testid]` > `#id` > shortest unique `tag[attr]` combo. Cap at 3 ancestor levels. If no unique short selector exists, omit it and rely on role + text + attributes.

### 3e. 🔵 Drop `browser.inspect.last` from initial implementation

It reads a file that's deleted after consumption. After Flow A the extension deletes it. After Flow B the `--wait` handler deletes it. So `inspect.last` almost always returns `no_element`. Remove it to reduce surface area — add later if a real use case emerges.


## 4. Testing Strategy

### Phase 1+2+3: Inspection Mode + JS + Bridge File

**Prereqs:** `./scripts/reload.sh --tag bridge` + `tail -f /tmp/cmux-debug-bridge.log`

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1 | Basic pick | Browser → `https://example.com` → picker button → hover `<h1>` → click | Crosshair cursor. Blue overlay tracks element. Tooltip: `heading "Example Domain"`. Bridge file written with `selector`, `role`, `text`, `url`, `pageTitle`. |
| 2 | Escape cancels | Enable picker → Escape | Overlay gone. Cursor normal. `isInspectionModeActive` → false. No bridge file. |
| 3 | Toggle off via button | Enable picker → click picker button again | Same as Escape. |
| 4 | Form element roles | Page with `<input>`, `<select>`, `<textarea>`, `<a>`, `<button>`, `<img>` → pick each | Correct roles: textbox, combobox, textbox, link, button, img. Relevant attrs present. |
| 5 | Long text truncation | Pick element with >80 chars textContent | `text` truncated to 80 chars + `…` |
| 6 | Navigation during inspection | Enable picker → navigate away | Inspection auto-cancels (requires fix 1b). |
| 7 | New tab page guard | On new-tab page → click picker | Nothing happens / "navigate first" notification. |
| 8 | Deep nesting | Pick element 10+ levels deep | Selector is valid CSS; verify with `document.querySelector(...)` in DevTools. |
| 9 | Bridge file content | After pick: `cat /tmp/cmux-bridge/<uuid>.json` | Valid JSON with `timestamp`, `workspace_id`, `selector`, `role`, `tagName`, `text`, `attributes`, `url`, `pageTitle`. |
| 10 | Repeat pick | Pick → verify file → enable picker → pick different element | Second file overwrites first. New timestamp. New data. |

### Phase 4: Socket/CLI Command

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 11 | Non-blocking enable | `cmux browser inspect` | Returns `{"status": "enabled"}` immediately. Browser shows crosshair. |
| 12 | Blocking wait — success | Terminal A: `cmux browser inspect --wait &` → click element in browser | Terminal A prints element JSON. Exit 0. |
| 13 | Blocking wait — escape | `cmux browser inspect --wait &` → Escape | Returns `{"status": "cancelled"}`. Exit 0. |
| 14 | Blocking wait — timeout | `cmux browser inspect --wait --timeout-ms 3000` → wait | Returns `{"status": "timeout"}` after 3s. Inspection disabled. |
| 15 | No browser panel | Close all browser splits → `cmux browser inspect` | Error: surface not browser / no focused surface. |
| 16 | Concurrent commands | During `--wait`, run `cmux browser url get` from other terminal | Must not hang (verifies deadlock fix 1a applied). |

### Phase 5+6: Toolbar Button + Keyboard Shortcut

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 17 | Button visibility | Open browser split | Scope icon in toolbar near devtools/theme buttons. |
| 18 | Button active state | Click picker button | Icon becomes accent-colored/bold. Returns to secondary on deactivate. |
| 19 | Banner | Enable inspection mode | Banner between chrome bar and web content: "Click any element… ESC to cancel". Disappears on cancel/pick. |
| 20 | Cmd+Shift+I | Focus browser → Cmd+Shift+I | Inspection toggles. Same as button. |
| 21 | Shortcut only in browser | Focus terminal → Cmd+Shift+I | Nothing. Event not consumed. |
| 22 | Hidden on new tab page | Open new tab | Picker button hidden (matches theme/devtools behavior). |

### Phase 7: Pi Extension (End-to-End)

**Prereqs:** Extension installed at `~/.pi/agent/extensions/browser-bridge/`. Pi running in cmux terminal. `echo $CMUX_WORKSPACE_ID` set.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 23 | Flow A e2e | Picker button → click `<button>` | Formatted reference appears in pi editor input. |
| 24 | Flow A no pi | Pick element with no pi session | Bridge file written, nothing consumes it. No crash. |
| 25 | Flow B agent tool | Ask pi "Which button should I click? Use browser_inspect" | Pi calls tool → inspection mode → click → tool returns data → LLM responds with element info. |
| 26 | Flow B timeout | Trigger tool → don't click for 30s | Tool returns "timed out". LLM handles gracefully. |
| 27 | `/inspect` command | Type `/inspect` in pi | Browser enters inspection mode. Notification shown. |
| 28 | Extension outside cmux | Run pi in regular terminal | Extension returns early. No errors. No watchers. |
| 29 | Rapid picks | Pick → re-enable → pick → re-enable → pick (5 times fast) | All 5 references pasted, in order, no duplicates. |
| 30 | fs.watch reliability | Pick 10 elements in sequence | All 10 pasted. If any missed → implement `watchFile` fallback. |

### Regression Checks

| # | Check |
|---|-------|
| 31 | Normal browser navigation still works (links, URL bar, back/forward). |
| 32 | DevTools toggle still works (Opt+Cmd+I or button). |
| 33 | No typing lag in terminal splits (no runaway timers). |
| 34 | `cmux browser eval "document.title"` still works (no JS namespace collision). |
| 35 | Split drag-and-drop still works (no UTType conflicts). |
| 36 | Memory: pick 20 elements, check Activity Monitor — no unbounded growth. |


## Summary: Must-Fix Before Implementation

| Priority | Issue | Section |
|----------|-------|---------|
| 🔴 P0 | `--wait` deadlock freezes entire app | §1a |
| 🔴 P0 | Navigation destroys JS, zombie inspection mode | §1b |
| 🟡 P1 | Bridge file keyed by workspaceId, not surfaceId | §1c |
| 🟡 P1 | Non-atomic file write → partial JSON reads | §1d |
| 🔵 Simplify | Use WKScriptMessageHandler instead of polling | §3a |
| 🔵 Simplify | Merge Phases 1+3 | §3c |
| 🔵 Simplify | Drop `browser.inspect.last` from v1 | §3e |
