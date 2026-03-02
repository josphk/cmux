# Browser Bridge: Element Picker → Agent Chat

## Goal

Click elements in the cmux browser and have them automatically referenced in the pi agent chat — similar to Cursor's embedded browser.

## Design Constraints

1. **Inspect mode is toggled via a button** in the browser's top-right toolbar, with a keyboard shortcut.
2. **Build for pi-coding-agent first**, leveraging pi extensions. Claude Code support considered later.

## User Flow

```
1. User clicks 🎯 picker button in browser toolbar (or Cmd+Shift+I)
2. Browser enters inspection mode (crosshair, hover highlight, tooltip)
3. User clicks an element → it auto-appends to the agent chat
4. User clicks another element → also appends (stays in inspection mode)
5. User keeps clicking as many elements as needed
6. User clicks 🎯 again (or Cmd+Shift+I) to exit inspection mode
7. User switches to agent chat — all elements are there as context
8. User types their question and hits Enter
```

**Key UX principle:** The user never leaves the browser during picking. Each click
immediately appears in the agent conversation. No context switching until they're
ready to ask their question.

### Secondary: Agent-initiated

```
1. LLM calls `browser_inspect` tool ("show me which element to fix")
2. Pi extension runs `cmux browser inspect --wait`
3. cmux enables inspection mode, waits for user click(s)
4. User clicks element(s), presses ESC
5. All picked elements returned to LLM as tool result
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  cmux App (Swift/AppKit)                            │
│                                                     │
│  BrowserPanelView toolbar: [← → URL 🎯 ⚙️]         │
│                    picker button ─┐                 │
│                                   ▼                 │
│  BrowserPanel.swift                                 │
│  ├─ toggleInspectionMode()                          │
│  ├─ JS: highlight + click intercept                 │
│  ├─ WKScriptMessageHandler receives clicks          │
│  ├─ writeBridgeEvent() ────────────────────────┐    │
│  │   (appends JSONL, one line per pick)        │    │
│  ├─ flash + toast on each pick                 │    │
│  └─ stays in inspect mode until ESC            │    │
│                                                │    │
│  Navigation delegate                           │    │
│  └─ auto-cancels inspection on navigate        │    │
│                                                │    │
│  TerminalController.swift                      │    │
│  └─ browser.inspect (socket cmd)               │    │
│      └─ enable on main, poll off-main          │    │
└────────────────────────────────────────────────│────┘
                                                 │
          /tmp/cmux-bridge/<surface-id>.jsonl ◄──┘
          (one JSON object per line, append-only)
                                                 │
┌────────────────────────────────────────────────│────┐
│  Pi Extension (TypeScript)                     │    │
│  ~/.pi/agent/extensions/browser-bridge/        │    │
│                                                │    │
│  index.ts                                      │    │
│  ├─ fs.watch bridge file ◄─────────────────────┘    │
│  ├─ on new line → pi.sendMessage() to conversation  │
│  │   (each element appears as a chat message)       │
│  │                                                  │
│  ├─ registerTool("browser_inspect")                 │
│  │   └─ pi.exec("cmux browser inspect --wait")     │
│  │   └─ returns all picked elements to LLM         │
│  │                                                  │
│  └─ registerCommand("/inspect")                     │
│      └─ enables inspection mode from terminal       │
└─────────────────────────────────────────────────────┘
```

## Implementation Phases

Incorporates fixes from REVIEW.md: WKScriptMessageHandler instead of polling,
multi-pick persistence, navigation guard, atomic file writes, surface-scoped bridge files.

---

### Phase 1: Inspection Mode + Message Handler (BrowserPanel.swift)

Add inspection mode state, WKScriptMessageHandler for zero-latency click events,
and JSONL bridge file for multi-pick.

**File**: `Sources/Panels/BrowserPanel.swift`

**1a. State** (~line 1290, after other @Published properties):

```swift
/// Whether browser inspection/picker mode is active.
@Published private(set) var isInspectionModeActive: Bool = false

/// Count of elements picked in the current inspection session.
@Published private(set) var inspectionPickCount: Int = 0

/// The surface ID for this browser panel (used for bridge file scoping).
var inspectionSurfaceId: String = ""
```

**1b. WKScriptMessageHandler** — register in webView config (~line 1370):

```swift
// In setupWebView() or wherever WKWebViewConfiguration is built:
config.userContentController.add(self, name: "cmuxInspect")
```

Conform `BrowserPanel` to `WKScriptMessageHandler`:

```swift
extension BrowserPanel: WKScriptMessageHandler {
    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "cmuxInspect",
              let dict = message.body as? [String: Any]
        else { return }
        handleInspectedElement(dict)
    }
}
```

**1c. Lifecycle**:

```swift
func enableInspectionMode() {
    guard !isInspectionModeActive, !isShowingNewTabPage else { return }
    isInspectionModeActive = true
    inspectionPickCount = 0

    // Clear any stale bridge file from previous session
    clearBridgeFile()

    webView.evaluateJavaScript(Self.inspectionModeScript) { [weak self] _, error in
        guard let self else { return }
        if let error {
            NSLog("BrowserPanel inspectionMode error: %@", error.localizedDescription)
            self.isInspectionModeActive = false
            return
        }
    }
}

func disableInspectionMode() {
    guard isInspectionModeActive else { return }
    isInspectionModeActive = false
    webView.evaluateJavaScript("window.__cmuxInspectCleanup && window.__cmuxInspectCleanup()") { _, _ in }

    #if DEBUG
    dlog("browser.inspect.end picked=\(inspectionPickCount)")
    #endif
}

func toggleInspectionMode() {
    isInspectionModeActive ? disableInspectionMode() : enableInspectionMode()
}
```

**1d. Navigation guard** — auto-cancel inspection when the page navigates:

```swift
// In the WKNavigationDelegate (already implemented), add to didCommitNavigation:
func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // ... existing code ...

    if isInspectionModeActive {
        disableInspectionMode()
        // Optionally: re-enable after load finishes (didFinish) if we want
        // to survive SPA soft navigations. For now, cancel cleanly.
    }
}
```

**1e. Bridge file** — append one JSON line per pick (JSONL format), atomic write:

```swift
private var bridgeFileURL: URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("cmux-bridge")
        .appendingPathComponent("\(inspectionSurfaceId).jsonl")
}

private func handleInspectedElement(_ data: [String: Any]) {
    inspectionPickCount += 1

    let bridgeDir = bridgeFileURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: bridgeDir, withIntermediateDirectories: true)

    var payload = data
    payload["timestamp"] = ISO8601DateFormatter().string(from: Date())
    payload["surface_id"] = inspectionSurfaceId
    payload["pick_index"] = inspectionPickCount
    payload["event_id"] = UUID().uuidString

    if let jsonData = try? JSONSerialization.data(withJSONObject: payload),
       var line = String(data: jsonData, encoding: .utf8) {
        line += "\n"

        // Atomic append: write to .tmp, then append to .jsonl
        let tmpFile = bridgeDir.appendingPathComponent("\(inspectionSurfaceId).tmp")
        try? line.write(to: tmpFile, atomically: true, encoding: .utf8)

        if let handle = try? FileHandle(forWritingTo: bridgeFileURL) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            handle.closeFile()
        } else {
            // First pick — create the file
            try? line.write(to: bridgeFileURL, atomically: true, encoding: .utf8)
        }

        try? FileManager.default.removeItem(at: tmpFile)
    }

    #if DEBUG
    dlog("browser.inspect.pick #\(inspectionPickCount) selector=\(data["selector"] ?? "") role=\(data["role"] ?? "")")
    #endif
}

private func clearBridgeFile() {
    try? FileManager.default.removeItem(at: bridgeFileURL)
}
```

---

### Phase 2: JavaScript Injection

Inject JavaScript for hover overlay, tooltip, click intercept. Clicks post to
`WKScriptMessageHandler` instead of setting a global variable.

**File**: `Sources/Panels/BrowserPanel.swift` (static let on BrowserPanel)

**Key behaviors:**
- `position: fixed` overlay tracks hovered element via `getBoundingClientRect()`
- Tooltip shows `role: "label text"` below element
- Crosshair cursor via injected `<style>`
- Click intercepted (`preventDefault` + `stopImmediatePropagation` on capture phase)
- **Posts element data** via `window.webkit.messageHandlers.cmuxInspect.postMessage(data)`
- **Stays in inspection mode after click** — brief green flash on picked element, then resumes
- Cleanup (called by Swift `disableInspectionMode()`) removes all injected DOM/listeners

**Element data posted on click:**

```json
{
  "selector": "form > button.primary-submit",
  "text": "Submit Form",
  "role": "button",
  "tagName": "button",
  "attributes": { "type": "submit", "class": "primary-submit" },
  "url": "http://localhost:3000/login",
  "pageTitle": "Login — My App"
}
```

**JS click handler (multi-pick):**

```javascript
function handleClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const data = extractElementData(e.target);
    window.webkit.messageHandlers.cmuxInspect.postMessage(data);

    // Brief green flash on picked element (200ms)
    flashElement(e.target);

    // Do NOT exit inspection mode — stay active for more picks
}
```

**Selector generation**: Prefer `[data-testid]` > `#id` > shortest `tag[attr]` combo. Cap at 3 ancestor levels.

**Role detection**: Check `role` attr → infer from tag+type (button, link, textbox, checkbox, radio, combobox, img, heading).

**Label extraction**: `aria-label` → `aria-labelledby` text → `textContent` (truncated 80 chars).

**iframe handling**: If hovered element is `<iframe>`, tooltip shows "iframe — inner elements not supported".

---

### Phase 3: Browser Toolbar Button + Banner (BrowserPanelView.swift)

Add picker button and inspection banner to the browser UI.

**File**: `Sources/Panels/BrowserPanelView.swift`

**3a. Picker button** — in the toolbar HStack, right side:

```swift
Button(action: { panel.toggleInspectionMode() }) {
    Image(systemName: "scope")
        .foregroundColor(panel.isInspectionModeActive ? .accentColor : .secondary)
        .font(.system(size: 13, weight: panel.isInspectionModeActive ? .bold : .regular))
}
.buttonStyle(.plain)
.help("Pick element for agent chat (⌘⇧I)")
.padding(.horizontal, 4)
.disabled(panel.isShowingNewTabPage)
```

**3b. Inspection banner** — between chrome bar and web content:

```swift
if panel.isInspectionModeActive {
    HStack(spacing: 6) {
        Image(systemName: "scope")
            .font(.system(size: 11))
            .foregroundColor(.accentColor)
        Text("Click elements to reference in chat")
            .font(.system(size: 11))
            .foregroundColor(.secondary)
        if panel.inspectionPickCount > 0 {
            Text("(\(panel.inspectionPickCount) picked)")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.accentColor)
        }
        Spacer()
        Text("⌘⇧I to finish")
            .font(.system(size: 10))
            .foregroundColor(.tertiaryLabel)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 4)
    .background(Color.accentColor.opacity(0.08))
}
```

---

### Phase 4: Keyboard Shortcut (AppDelegate.swift)

Register Cmd+Shift+I to toggle inspection mode when a browser panel is focused.

**File**: `Sources/AppDelegate.swift` (~line 4637)

```swift
// Cmd+Shift+I → toggle browser inspection mode
if event.modifierFlags.contains([.command, .shift])
   && event.charactersIgnoringModifiers == "i"
   && event.type == .keyDown {
    if let browserPanel = self.focusedBrowserPanel() {
        browserPanel.toggleInspectionMode()
        return nil  // consume event
    }
}
```

---

### Phase 5: Socket/CLI Command (TerminalController.swift + CLI/cmux.swift)

**File**: `Sources/TerminalController.swift`

**5a. Route** (~line 1250):

```swift
case "browser.inspect":
    return v2Result(id: id, self.v2BrowserInspect(params: params))
```

**5b. Implementation** — enable on main, poll off-main (fixes P0 deadlock):

```swift
private func v2BrowserInspect(params: [String: Any]) -> V2CallResult {
    let wait = v2Bool(params, "wait") ?? false
    let timeoutMs = v2Int(params, "timeout_ms") ?? 30000

    // Step 1: Enable inspection on main thread (fast, returns immediately)
    let surfaceId: String = // resolve from params
    let browserPanel: BrowserPanel = // resolve from params

    DispatchQueue.main.async {
        browserPanel.enableInspectionMode()
    }

    if !wait {
        return .success(["status": "enabled"])
    }

    // Step 2: Poll bridge file OFF-MAIN (socket handler thread)
    let bridgeFile = FileManager.default.temporaryDirectory
        .appendingPathComponent("cmux-bridge")
        .appendingPathComponent("\(surfaceId).jsonl")

    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)

    while Date() < deadline {
        // Check if inspection was cancelled (read off-main is safe for published bool)
        if !browserPanel.isInspectionModeActive {
            // Read all picks from JSONL
            return .success(readAllPicks(from: bridgeFile))
        }
        Thread.sleep(forTimeInterval: 0.2)
    }

    // Timeout — disable and return what we have
    DispatchQueue.main.async { browserPanel.disableInspectionMode() }
    return .success(readAllPicks(from: bridgeFile))
}

private func readAllPicks(from url: URL) -> [String: Any] {
    guard let content = try? String(contentsOf: url, encoding: .utf8) else {
        return ["status": "no_elements", "elements": []]
    }
    let elements = content.split(separator: "\n").compactMap { line -> [String: Any]? in
        guard let data = line.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    return ["status": "ok", "elements": elements, "count": elements.count]
}
```

**5c. CLI** (`CLI/cmux.swift`):

```bash
# Enable inspection mode (non-blocking)
cmux browser inspect

# Wait for user to pick elements and press ESC (returns all picks)
cmux browser inspect --wait --timeout-ms 30000
```

---

### Phase 6: Pi Extension — Browser Bridge

The pi extension that auto-appends picked elements to the agent conversation.

**File**: `~/.pi/agent/extensions/browser-bridge/index.ts`

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function (pi: ExtensionAPI) {
  const isCmux = !!process.env.CMUX_WORKSPACE_ID;
  if (!isCmux) return;

  const surfaceId = process.env.CMUX_SURFACE_ID!;
  const bridgeDir = path.join(os.tmpdir(), "cmux-bridge");

  // --- Flow A: Watch bridge file, auto-append to conversation ---

  let lastLineCount = 0;
  let watcher: fs.FSWatcher | null = null;
  let sessionCtx: any = null;

  function getBridgeFiles(): string[] {
    // Watch all .jsonl files in bridge dir (any surface in this workspace)
    try {
      return fs.readdirSync(bridgeDir).filter(f => f.endsWith(".jsonl"));
    } catch { return []; }
  }

  function processNewLines() {
    if (!sessionCtx) return;

    for (const file of getBridgeFiles()) {
      const filePath = path.join(bridgeDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        // Track lines per file
        const key = file;
        const prevCount = (processNewLines as any)[key] || 0;

        for (let i = prevCount; i < lines.length; i++) {
          const data = JSON.parse(lines[i]);
          const formatted = formatElement(data);

          // Append element as a message in the conversation
          pi.sendMessage({
            customType: "browser-element",
            content: formatted,
            display: true,
            details: data,
          });
        }

        (processNewLines as any)[key] = lines.length;
      } catch {
        // File not ready — ignore
      }
    }
  }

  function startWatching(ctx: any) {
    sessionCtx = ctx;
    try { fs.mkdirSync(bridgeDir, { recursive: true }); } catch {}

    watcher = fs.watch(bridgeDir, () => {
      processNewLines();
    });

    // Also poll every 2s as fallback (fs.watch can be unreliable on macOS)
    const interval = setInterval(() => processNewLines(), 2000);
    (startWatching as any).interval = interval;
  }

  pi.on("session_start", async (_event, ctx) => {
    startWatching(ctx);
  });

  pi.on("session_shutdown", async () => {
    watcher?.close();
    watcher = null;
    clearInterval((startWatching as any).interval);
  });

  // --- Flow B: Agent-initiated tool ---

  pi.registerTool({
    name: "browser_inspect",
    label: "Browser Inspect",
    description:
      "Ask the user to click element(s) in the cmux browser. " +
      "Enables inspection mode — user clicks elements and presses ESC when done. " +
      "Returns all picked elements with selectors, roles, text, and attributes.",
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          description: "Message explaining what to click (shown to user)",
        })
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Timeout in ms (default 60000)", default: 60000 })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const timeout = params.timeout_ms ?? 60000;

      if (params.prompt) {
        ctx.ui.notify(params.prompt, "info");
      }

      const result = await pi.exec(
        "cmux",
        ["browser", "inspect", "--wait", "--timeout-ms", String(timeout)],
        { signal, timeout: timeout + 5000 }
      );

      if (result.code !== 0 || !result.stdout.trim()) {
        return {
          content: [{ type: "text", text: "Inspection cancelled or timed out." }],
          isError: false,
        };
      }

      try {
        const data = JSON.parse(result.stdout);
        const elements = data.elements || [];

        if (elements.length === 0) {
          return {
            content: [{ type: "text", text: "No elements were selected." }],
            isError: false,
          };
        }

        const formatted = elements.map(formatElement).join("\n\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: data,
        };
      } catch {
        return {
          content: [{ type: "text", text: `Raw: ${result.stdout}` }],
        };
      }
    },
  });

  // --- /inspect command ---

  pi.registerCommand("inspect", {
    description: "Toggle browser element picker — click elements to reference them",
    handler: async (args, ctx) => {
      try {
        const result = await pi.exec("cmux", ["browser", "inspect"]);
        if (result.code === 0) {
          ctx.ui.notify("Inspection mode on — click elements in browser, ESC to finish", "info");
        } else {
          ctx.ui.notify("No browser panel found", "warning");
        }
      } catch {
        ctx.ui.notify("Failed to toggle inspection mode", "error");
      }
    },
  });

  // --- Custom message renderer ---

  pi.registerMessageRenderer("browser-element", (message, options, theme) => {
    const { Text } = require("@mariozechner/pi-tui");
    const styled = theme.fg("accent", "🎯 ") + message.content;
    return new Text(styled, 0, 0);
  });
}

// --- Formatting ---

function formatElement(data: any): string {
  const role = data.role || data.tagName || "element";
  const text = data.text || "";
  const selector = data.selector || "";
  const attrs = data.attributes || {};

  let parts = [`<browser-element`, `selector="${selector}"`, `role="${role}"`];
  if (text) parts.push(`text="${text}"`);
  for (const key of ["href", "src", "placeholder", "name", "data-testid", "type", "alt"]) {
    if (attrs[key]) parts.push(`${key}="${attrs[key]}"`);
  }
  if (data.url) parts.push(`page="${data.url}"`);
  parts.push("/>");

  return parts.join(" ");
}
```

---

## File Change Summary

| File | Type | Changes |
|------|------|---------|
| `Sources/Panels/BrowserPanel.swift` | Swift | Inspection state, WKScriptMessageHandler, JSONL bridge write, navigation guard |
| `Sources/Panels/BrowserPanelView.swift` | Swift | Picker button in toolbar, inspection banner with pick count |
| `Sources/AppDelegate.swift` | Swift | Cmd+Shift+I keyboard shortcut |
| `Sources/TerminalController.swift` | Swift | `browser.inspect` socket command (enable on main, poll off-main) |
| `CLI/cmux.swift` | Swift | `cmux browser inspect [--wait]` CLI |
| `~/.pi/agent/extensions/browser-bridge/index.ts` | TypeScript | File watcher, `browser_inspect` tool, `/inspect` cmd, message renderer |

## Implementation Order

| Step | What | Est. |
|------|------|------|
| 1 | Phase 1: State + WKScriptMessageHandler + bridge file | 2-3h |
| 2 | Phase 2: JS injection (overlay, tooltip, multi-pick, flash) | 2-3h |
| 3 | Phase 3: Toolbar button + banner | 1-2h |
| 4 | Phase 4: Keyboard shortcut | 30m |
| 5 | **Test: `./scripts/reload.sh --tag bridge`** | — |
| 6 | Phase 5: Socket/CLI command | 1-2h |
| 7 | Phase 6: Pi extension | 2-3h |
| 8 | **End-to-end test: multi-pick → elements in pi chat** | — |

**Total: ~3-4 days**

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `fs.watch` unreliable on macOS | 2s polling fallback in extension |
| Bridge file partial read | Atomic append (write line, seek-to-end) + JSONL per-line parsing |
| Navigation destroys JS | `didCommitNavigation` auto-cancels inspection |
| `--wait` deadlock | Enable on main (async), poll bridge file off-main |
| Inspection breaks page | Capture-phase handler, `pointer-events: none` on overlay, toggle off via button/shortcut |
| Cmd+Shift+I conflict | Safari DevTools is Opt+Cmd+I (different modifier) |
| Stale bridge files | Include `event_id` UUID, clear on `enableInspectionMode()` |
| iframe clicks | Tooltip: "iframe — inner elements not supported" |

## Future Enhancements

- **Screenshot crop**: Include cropped screenshot of clicked element area
- **Smart formatting**: Detect test/CSS context, format accordingly
- **Cross-frame**: Inject into iframes via `contentDocument`
- **Shadow DOM**: Pierce shadow roots
- **Claude Code support**: Clipboard + OSC for non-pi agents
- **Element history**: `/inspect-history` showing last N sessions
