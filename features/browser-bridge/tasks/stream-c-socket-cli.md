You are working on the cmux browser-bridge feature. Your task is to add the `browser.inspect` socket command and `cmux browser inspect` CLI command.

## Output

Write TWO patch files describing the exact changes:
1. `features/browser-bridge/patches/terminal-controller.patch.swift` — the new methods to add to TerminalController.swift
2. `features/browser-bridge/patches/cli-cmux.patch.swift` — the new CLI subcommand to add to CLI/cmux.swift

Write these as standalone Swift code blocks with comments indicating WHERE in the file they should be inserted.

## Context

Read these files to understand existing patterns:
- `Sources/TerminalController.swift` — look at existing browser commands (search for `browser.` and `v2Browser`), the V2 handler switch, and `v2BrowserWithPanel` helper
- `CLI/cmux.swift` — look at existing browser subcommands (search for `"browser"` and the browser command switch)

## Requirements

### TerminalController.swift

**1. Add route** in the V2 handler switch (find where other `"browser.*"` cases are):
```swift
case "browser.inspect":
    return v2Result(id: id, self.v2BrowserInspect(params: params))
```

**2. Implement `v2BrowserInspect`**:
- Extract params: `wait` (bool, default false), `timeout_ms` (int, default 30000)
- Resolve browser panel using existing `v2BrowserWithPanel` helper pattern
- **Non-wait mode**: Enable inspection on main thread via `DispatchQueue.main.async`, return `{"status": "enabled"}` immediately
- **Wait mode**: 
  - Enable inspection on main thread (async, non-blocking)
  - Poll the bridge JSONL file OFF the main thread (every 200ms)
  - Check `browserPanel.isInspectionModeActive` to know when user finished (ESC)
  - On finish or timeout, read all JSONL lines and return them
  - On timeout, also disable inspection mode via `DispatchQueue.main.async`
- **CRITICAL**: Do NOT put the wait loop inside `DispatchQueue.main.sync` — that deadlocks the entire app

**3. Implement `readAllPicks(from:)`** helper:
```swift
private func readAllPicks(from url: URL) -> [String: Any] {
    // Read JSONL file, parse each line as JSON, return array
    // Handle: file doesn't exist, empty file, malformed lines
}
```

**4. Bridge file location**:
```swift
let bridgeFile = FileManager.default.temporaryDirectory
    .appendingPathComponent("cmux-bridge")
    .appendingPathComponent("\(surfaceId).jsonl")
```

### CLI/cmux.swift

Add `inspect` as a browser subcommand:

```
cmux browser inspect              — enable inspection mode (non-blocking)
cmux browser inspect --wait       — wait for user to pick elements, print JSON
cmux browser inspect --wait --timeout-ms 30000
```

- Follow existing browser subcommand patterns for argument parsing
- For `--wait`: send V2 request with `"wait": true`, print response JSON to stdout
- For non-wait: send V2 request, print status

### Interface Contract

These properties/methods will exist on `BrowserPanel` (being built in parallel):
```swift
// Properties
var isInspectionModeActive: Bool { get }      // @Published
var inspectionPickCount: Int { get }          // @Published  
var inspectionSurfaceId: String { get set }

// Methods
func enableInspectionMode()
func disableInspectionMode()

// Bridge file
var bridgeFileURL: URL { get }  // /tmp/cmux-bridge/<surfaceId>.jsonl
```

### Important Patterns from Existing Code

Search the files for these patterns to match the style:
- `v2BrowserWithPanel` — how browser commands resolve the target panel
- `v2Bool`, `v2Int`, `v2String` — param extraction helpers
- `V2CallResult` — return type (.success, .error)
- `v2Result(id:_:)` — wrapping results
- How `--wait` is handled in other commands (if any)

When done, just say "Stream C complete" and stop.
