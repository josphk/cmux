# cmux Browser Architecture

## Overview

The browser in cmux is a **WebKit-based panel** that sits alongside terminal panels in the split/workspace system. It's designed to be **scriptable** with a full CLI/socket API ported from [agent-browser](https://github.com/vercel-labs/agent-browser), allowing AI coding agents to interact with web pages programmatically.

## Key Components

### 1. **Panel System** (`Sources/Panels/`)

All content in cmux implements the `Panel` protocol:

```swift
protocol Panel: AnyObject, Identifiable, ObservableObject {
    var id: UUID { get }
    var panelType: PanelType { get }  // .terminal or .browser
    var displayTitle: String { get }
    var displayIcon: String? { get }
    func close()
    func focus()
    func unfocus()
    func triggerFlash()
}
```

- **TerminalPanel** - Wraps Ghostty terminal surfaces
- **BrowserPanel** - Wraps WKWebView with automation features

### 2. **BrowserPanel** (`Sources/Panels/BrowserPanel.swift`)

The core browser implementation (~3300 lines):

#### Key Properties

```swift
class BrowserPanel: Panel, ObservableObject {
    // Shared cookie pool across all browser panels
    private static let sharedProcessPool = WKProcessPool()
    
    // WebKit view
    let webView: WKWebView
    
    // Observable state
    @Published private(set) var currentURL: URL?
    @Published private(set) var pageTitle: String
    @Published private(set) var faviconPNGData: Data?
    @Published private(set) var isLoading: Bool
    @Published private(set) var canGoBack: Bool
    @Published private(set) var canGoForward: Bool
    @Published private(set) var estimatedProgress: Double
    
    // Browser automation state
    private var elementRefCache: ElementRefCache
    private var frameStack: [BrowserFrameHandle]
}
```

#### Features

1. **WebKit Integration**
   - Uses `WKWebView` for rendering
   - Shared process pool for cookie sharing
   - Custom user agent support
   - Dark mode injection based on Ghostty theme

2. **Telemetry Hooks** (Injected JavaScript)
   - Console logging (`window.console.log/warn/error`)
   - Error tracking (`window.onerror`, `unhandledrejection`)
   - Dialog tracking (`alert/confirm/prompt`)
   - Stored in `window.__cmuxConsoleLog` and `window.__cmuxErrorLog`

3. **Session Restoration**
   - Saves/restores URL, title, scroll position
   - Back/forward navigation history
   - Working directory context

4. **Link Handling**
   - Configurable URL whitelist for in-app vs external browser
   - Cmd+click / middle-click opens in new tab
   - HTTP allowlist for localhost/dev servers
   - Smart "open" command interception from terminal

### 3. **BrowserPanelView** (`Sources/Panels/BrowserPanelView.swift`)

SwiftUI view that renders the browser UI (~148KB):

#### UI Components

```
┌─────────────────────────────────────────┐
│ ┌─────┬───────────────────────┬────┐   │ Chrome Bar
│ │ ← → │  Address Bar         │ ⚙️  │   │
│ └─────┴───────────────────────┴────┘   │
├─────────────────────────────────────────┤
│                                         │
│          WKWebView                      │  Content
│      (or New Tab Page)                  │
│                                         │
├─────────────────────────────────────────┤
│  [Developer Console] (optional)         │  DevTools
└─────────────────────────────────────────┘
```

- **Chrome bar**: Back/forward, address bar, reload, settings
- **New tab page**: Shows before first navigation
- **Developer console**: Toggleable console (Cmd+Opt+C)
- **Find-in-page**: Built-in search (Cmd+F)

### 4. **CmuxWebView** (`Sources/Panels/CmuxWebView.swift`)

AppKit wrapper that bridges WKWebView to SwiftUI:

```swift
struct CmuxWebView: NSViewRepresentable {
    let webView: WKWebView
    let themeBackgroundColor: NSColor
    let isFocused: Bool
    
    func makeNSView(context: Context) -> WKWebView { ... }
    func updateNSView(_ nsView: WKWebView, context: Context) { ... }
}
```

Handles:
- View lifecycle
- Focus management
- Background color matching with Ghostty theme
- Mouse/keyboard event routing

### 5. **Socket/CLI Commands** (`CLI/cmux.swift`, `Sources/TerminalController.swift`)

The browser has a comprehensive automation API:

#### Navigation

```bash
# Open browser in split
cmux browser open [--url URL] [--workspace WS] [--split-direction DIR]

# Navigate
cmux browser navigate URL [--surface SURFACE_ID]
cmux browser back/forward/reload

# Get current URL
cmux browser url
```

#### Accessibility Tree Snapshot

The **killer feature** - builds a lightweight DOM tree:

```bash
cmux browser snapshot [--selector SCOPE] [--interactive] [--compact] [--max-depth N]
```

**How it works:**

1. Injects JavaScript into the page
2. Traverses DOM starting from `scopeSelector` (or document root)
3. Filters nodes based on:
   - Visibility (`getComputedStyle`, `getBoundingClientRect`)
   - Interactive roles (buttons, links, inputs)
   - Content roles (headings, cells, text)
4. Builds a tree with **element references** (stable IDs)
5. Returns JSON with role, text, attributes, bounding boxes

**Example output:**

```json
{
  "children": [
    {
      "role": "button",
      "text": "Submit",
      "ref": "cmux-ref-1",
      "x": 100, "y": 50, "width": 80, "height": 32,
      "attrs": {"type": "submit", "class": "primary-btn"}
    },
    {
      "role": "textbox",
      "text": "",
      "ref": "cmux-ref-2",
      "placeholder": "Enter email",
      "x": 100, "y": 100, "width": 200, "height": 32
    }
  ]
}
```

#### Element Interaction

Uses **element references** from snapshot:

```bash
# Click/hover/focus
cmux browser click SELECTOR_OR_REF
cmux browser hover SELECTOR_OR_REF
cmux browser focus SELECTOR_OR_REF

# Type/fill forms
cmux browser type SELECTOR_OR_REF "text to type"
cmux browser fill SELECTOR_OR_REF "value"

# Checkboxes/selects
cmux browser check SELECTOR_OR_REF
cmux browser select SELECTOR_OR_REF --value "option1"

# Keyboard
cmux browser press "Enter"
cmux browser keydown "Control"
cmux browser keyup "Control"
```

#### Queries

```bash
# Get element properties
cmux browser get text SELECTOR
cmux browser get html SELECTOR
cmux browser get value SELECTOR
cmux browser get attr SELECTOR --name "href"

# Element state
cmux browser is visible SELECTOR
cmux browser is enabled SELECTOR
cmux browser is checked SELECTOR
```

#### Finding Elements

```bash
# By role/text/label
cmux browser find role --role button --name "Submit"
cmux browser find text --text "Click here"
cmux browser find label --label "Email"

# By attributes
cmux browser find placeholder --placeholder "Search"
cmux browser find testid --testid "login-btn"

# Nth matching
cmux browser find nth --selector "button" --index 2
```

#### Advanced Features

```bash
# JavaScript evaluation
cmux browser eval "document.title"
cmux browser eval "return fetch('/api/data').then(r => r.json())"

# Wait for selectors/navigation
cmux browser wait --selector "#loaded-indicator" --timeout 5000

# Screenshots
cmux browser screenshot --output screenshot.png

# iframes
cmux browser frame select --selector "iframe[title='Payment']"
cmux browser frame main  # back to main frame

# Dialog handling
cmux browser dialog accept [--value "response text"]
cmux browser dialog dismiss
```

### 6. **Implementation Details**

#### Element Reference System

From `Sources/TerminalController.swift`:

```swift
// Element refs are stable IDs attached to DOM nodes
let script = """
if (!window.__cmuxElementRefCounter) window.__cmuxElementRefCounter = 0;
if (!window.__cmuxElementRefs) window.__cmuxElementRefs = new WeakMap();

function __getElementRef(el) {
  if (!el) return null;
  let ref = window.__cmuxElementRefs.get(el);
  if (!ref) {
    ref = 'cmux-ref-' + (++window.__cmuxElementRefCounter);
    window.__cmuxElementRefs.set(el, ref);
    el.__cmuxRef = ref;  // Also store on element for reverse lookup
  }
  return ref;
}
"""
```

- Uses `WeakMap` to avoid memory leaks
- Refs survive DOM changes (until element is GC'd)
- Faster than CSS selectors for repeated operations

#### Dark Mode Injection

```swift
// Injects CSS to force dark mode based on Ghostty theme
private func applyDarkModeCSS() {
    let css = """
    :root {
      color-scheme: dark !important;
    }
    html, body {
      background-color: rgb(30, 30, 30) !important;
      color: rgb(230, 230, 230) !important;
    }
    """
    webView.evaluateJavaScript(
        "document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...]"
    )
}
```

#### Notification Integration

```swift
// Browser can send notifications when agents need attention
func sendNotification(title: String, message: String) {
    NotificationCenter.default.post(
        name: .cmuxBrowserNotification,
        object: self,
        userInfo: ["title": title, "message": message]
    )
}
```

### 7. **Integration with Workspace System**

From `vendor/bonsplit/`:

```swift
// Browser panels sit in the same split/tab system as terminals
struct BonsplitLeaf {
    var panel: any Panel  // Can be TerminalPanel or BrowserPanel
}

// Split operations work the same
workspace.split(direction: .horizontal) { newSurface in
    newSurface.panel = BrowserPanel(url: url)
}
```

### 8. **Settings & Preferences**

Browser settings in `Sources/Panels/BrowserPanel.swift`:

```swift
enum BrowserSearchSettings {
    static let searchEngineKey = "browserSearchEngine"
    // Options: .google, .duckduckgo, .bing, .kagi
}

enum BrowserThemeSettings {
    static let modeKey = "browserThemeMode"
    // Options: .system, .light, .dark
}

enum BrowserLinkOpenSettings {
    static let openTerminalLinksInCmuxBrowserKey = "..."
    static let browserHostWhitelistKey = "..."
}

enum BrowserInsecureHTTPSettings {
    static let allowlistKey = "browserInsecureHTTPAllowlist"
    // Default: localhost, 127.0.0.1, *.localtest.me
}
```

## Making Changes

### Adding a new browser command

1. **Add CLI command** in `CLI/cmux.swift`:

```swift
// Around line 2300+
case "mynewcommand":
    let payload = try client.sendV2(
        method: "browser.mynewcommand",
        params: ["surface_id": sid, "arg": value]
    )
```

2. **Add handler** in `Sources/TerminalController.swift`:

```swift
// In handleV2Message switch ~line 1200
case "browser.mynewcommand":
    return v2Result(id: id, self.v2BrowserMyNewCommand(params: params))

// Implementation ~line 8000+
private func v2BrowserMyNewCommand(params: [String: Any]) -> V2CallResult {
    return v2BrowserWithPanel(params: params) { _, ws, surfaceId, browserPanel in
        // Your logic here
        let script = "..." // JavaScript to inject
        return browserPanel.evaluateJavaScriptAsync(script)
    }
}
```

3. **Update BrowserPanel** if needed:

```swift
// Add new method to BrowserPanel
func myNewFeature() async throws -> Any {
    return try await webView.evaluateJavaScript("...")
}
```

### Debugging

Enable the debug log (DEBUG builds only):

```bash
tail -f /tmp/cmux-debug.log
```

Browser events are logged:
- Navigation starts/completes
- JavaScript evaluation
- Element ref creation
- Dialog interceptions

## Architecture Benefits

1. **No Electron** - Native WKWebView = fast, low memory
2. **Agent-first** - Every feature has CLI/API access
3. **Privacy-focused** - Shared cookie pool, no telemetry sent to servers
4. **Terminal-integrated** - Same keybindings, theme, split system
5. **Extensible** - Add new automation commands easily

## Common Patterns

### Agent automation flow

```bash
# 1. Open browser
cmux browser open --url "http://localhost:3000"

# 2. Get accessibility tree
TREE=$(cmux browser snapshot --interactive)

# 3. Extract element refs from tree (with jq or similar)
LOGIN_BTN=$(echo $TREE | jq -r '.children[] | select(.text=="Login") | .ref')

# 4. Interact
cmux browser click "$LOGIN_BTN"
cmux browser fill "input[name='email']" "user@example.com"
cmux browser press "Enter"

# 5. Wait for result
cmux browser wait --selector ".dashboard" --timeout 5000

# 6. Verify
cmux browser get text ".welcome-message"
```

### Splitting browser alongside terminal

```bash
# Open terminal in left split
cmux surface new

# Open browser in right split
cmux browser open --split-direction right --url "http://localhost:3000"

# Now terminal and browser are side-by-side
# Agent can edit code in terminal, see results in browser
```

## Related Files

- **Panel protocol**: `Sources/Panels/Panel.swift`
- **Browser model**: `Sources/Panels/BrowserPanel.swift`
- **Browser UI**: `Sources/Panels/BrowserPanelView.swift`
- **WebView wrapper**: `Sources/Panels/CmuxWebView.swift`
- **Socket commands**: `Sources/TerminalController.swift` (lines 1168-1250, 7000+)
- **CLI interface**: `CLI/cmux.swift` (lines 2200-2700)
- **Settings**: `Sources/Settings/BrowserSettingsView.swift`
- **Window portal**: `Sources/BrowserWindowPortal.swift` (for window-level browser)

## Next Steps

Want to:
- Add a new browser command? See "Adding a new browser command" above
- Modify UI? Edit `BrowserPanelView.swift`
- Change automation behavior? Edit the JavaScript injection in `TerminalController.swift`
- Debug issues? Check `/tmp/cmux-debug.log` and `dlog()` calls

Let me know what you want to build!
