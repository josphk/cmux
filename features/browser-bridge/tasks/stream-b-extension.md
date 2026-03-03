You are working on the cmux browser-bridge feature. Your task is to write the **pi coding agent extension** that bridges browser element picks into the agent conversation.

## Output

Write the complete extension to: `features/browser-bridge/extension/index.ts`

## Context

cmux is a macOS terminal app. When a user clicks elements in the cmux browser's inspection mode, each pick is appended as a JSONL line to `/tmp/cmux-bridge/<surface-id>.jsonl`. This extension watches those files and injects picked elements into the pi agent conversation.

## Pi Extension API

Read the pi extension examples for API reference:
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/tools.ts` (registerTool)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/commands.ts` (registerCommand)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/send-user-message.ts` (sendMessage)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/notify.ts` (notifications)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/hello.ts` (basic structure)

Read these files first to understand the extension API patterns.

## Requirements

### 1. Guard: only activate inside cmux
```typescript
const isCmux = !!process.env.CMUX_WORKSPACE_ID;
if (!isCmux) return; // no-op outside cmux
```

### 2. Bridge file watcher (Flow A: user-initiated picks)
- Watch `/tmp/cmux-bridge/` directory for `.jsonl` files
- Use `fs.watch()` on the directory + 2-second `setInterval` polling fallback (fs.watch is unreliable on macOS)
- Track lines-read-per-file to only process NEW lines
- Each new JSONL line → parse JSON → format → send as user message to conversation
- Start watching on `session_start`, stop on `session_shutdown`

### 3. Format picked elements as XML-like tags
```
<browser-element selector="form > button.primary-submit" role="button" text="Submit Form" page="http://localhost:3000/login" />
```

Include these attributes if present: selector, role, text, href, src, placeholder, name, data-testid, type, alt, page.

### 4. `browser_inspect` tool (Flow B: agent-initiated)
- Register a tool that the LLM can call to ask the user to pick elements
- Parameters: `prompt` (optional string — message to show user), `timeout_ms` (optional number, default 60000)
- If prompt provided, show it as a notification
- Execute: `cmux browser inspect --wait --timeout-ms <timeout>`
- Parse stdout JSON, format elements, return as tool result
- Handle: timeout, cancellation, no elements selected, cmux not available

### 5. `/inspect` command
- Register command that toggles inspection mode
- Runs `cmux browser inspect` (non-blocking)
- Shows notification: "Inspection mode on — click elements in browser, ESC to finish"
- Handle errors gracefully (no browser panel found, etc.)

### 6. Error handling
- All file operations wrapped in try/catch
- Graceful degradation if cmux CLI not available
- No crashes if bridge files are malformed

## Bridge File Format

Location: `/tmp/cmux-bridge/<surface-id>.jsonl`

One JSON object per line (JSONL):
```json
{"selector":"button.submit","text":"Submit","role":"button","tagName":"BUTTON","attributes":{"type":"submit","class":"submit"},"url":"http://localhost:3000","pageTitle":"My App","timestamp":"2025-01-15T10:30:00Z","surface_id":"uuid-here","pick_index":1,"event_id":"uuid"}
```

## TypeScript Guidelines
- Use `import type` for type-only imports
- Use `node:fs` and `node:path` and `node:os` module prefixes
- Extension default export: `export default function(pi: ExtensionAPI) { ... }`
- Use `pi.exec()` for running CLI commands (NOT child_process)
- Use `pi.log()` for debug logging

When done, just say "Stream B complete" and stop.
