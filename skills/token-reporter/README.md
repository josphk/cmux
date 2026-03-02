# cmux Token Reporter

A [pi coding agent](https://github.com/nickvdyck/pi-coding-agent) extension that reports token usage and cost to cmux via its Unix socket.

## What it does

After each agent turn completes, this extension:

1. Walks the conversation branch to sum up token usage (input, output, cache read, cache write) and cost across all assistant messages.
2. Sends a `report_tokens` command to the cmux Unix socket with the accumulated totals.
3. Debounces reports — skips sending if the cost hasn't meaningfully changed (< $0.001 delta).

cmux uses this data to display live token cost in the sidebar.

## Installation

Copy or symlink the extension into your pi extensions directory:

```bash
# Symlink (recommended for development)
ln -s "$(pwd)/cmux-token-reporter.ts" ~/.pi/agent/extensions/cmux-token-reporter.ts

# Or copy
cp cmux-token-reporter.ts ~/.pi/agent/extensions/
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CMUX_SOCKET_PATH` | Path to cmux Unix socket | `/tmp/cmux.sock` |
| `CMUX_SOCKET` | Fallback socket path | `/tmp/cmux.sock` |

## Socket commands used

### `report_tokens`

Reports cumulative token usage for the current session.

```
report_tokens --cost=<float> --input=<int> --output=<int> [--cache-read=<int>] [--cache-write=<int>] [--model=<string>]
```

- `--cost` (required): Total cost in USD
- `--input`: Input token count
- `--output`: Output token count
- `--cache-read`: Cache read token count
- `--cache-write`: Cache write token count
- `--model`: Model identifier (e.g., `claude-sonnet-4-20250514`)

### `clear_tokens`

Clears the token usage display for the current surface.

```
clear_tokens
```
