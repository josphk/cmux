/**
 * cmux Browser Bridge Extension
 *
 * Bridges browser element picks from cmux inspection mode into the pi agent conversation.
 *
 * Flow A (user-initiated): Watches /tmp/cmux-bridge/*.jsonl for new picks and injects them
 *         as user messages.
 * Flow B (agent-initiated): Provides a `browser_inspect` tool the LLM can call to request
 *         the user pick elements.
 * Command: `/inspect` toggles inspection mode in the cmux browser panel.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const BRIDGE_DIR = "/tmp/cmux-bridge";
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;

/** Attributes to include in formatted output (in order). */
const ELEMENT_ATTRS = [
	"selector",
	"role",
	"text",
	"href",
	"src",
	"placeholder",
	"name",
	"data-testid",
	"type",
	"alt",
] as const;

/**
 * Format a picked element record as an XML-like tag.
 *
 * Example output:
 *   <browser-element selector="form > button.primary-submit" role="button" text="Submit" page="http://localhost:3000" />
 */
function formatElement(el: Record<string, unknown>): string {
	const attrs: string[] = [];

	for (const key of ELEMENT_ATTRS) {
		const val = el[key];
		if (val !== undefined && val !== null && val !== "") {
			attrs.push(`${key}="${escapeAttr(String(val))}"`);
		}
	}

	// "page" attribute sourced from the url field
	const page = el.url ?? el.page;
	if (page !== undefined && page !== null && page !== "") {
		attrs.push(`page="${escapeAttr(String(page))}"`);
	}

	return `<browser-element ${attrs.join(" ")} />`;
}

/** Escape double-quotes inside attribute values. */
function escapeAttr(value: string): string {
	return value.replace(/"/g, "&quot;");
}

export default function browserBridgeExtension(pi: ExtensionAPI) {
	// ── Guard: only activate inside cmux ──────────────────────────────────
	const isCmux = !!process.env.CMUX_WORKSPACE_ID;
	if (!isCmux) return;

	// ── Watcher state ─────────────────────────────────────────────────────
	/** Number of JSONL lines already processed per file path. */
	const linesRead = new Map<string, number>();
	let dirWatcher: fs.FSWatcher | null = null;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// ── Bridge file processing ────────────────────────────────────────────

	/** Read new lines from a single .jsonl file and send them as user messages. */
	function processFile(filePath: string): void {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());
			const alreadyRead = linesRead.get(filePath) ?? 0;

			if (lines.length <= alreadyRead) return;

			const newLines = lines.slice(alreadyRead);
			linesRead.set(filePath, lines.length);

			for (const line of newLines) {
				try {
					const el = JSON.parse(line) as Record<string, unknown>;
					const formatted = formatElement(el);
					pi.sendUserMessage(`[browser pick] ${formatted}`, { deliverAs: "followUp" });
				} catch {
					pi.log(`[browser-bridge] malformed JSONL line in ${filePath}: ${line}`);
				}
			}
		} catch {
			// File may have been deleted or is temporarily inaccessible — skip silently.
		}
	}

	/** Scan the bridge directory for all .jsonl files and process new lines. */
	function scanBridgeDir(): void {
		try {
			if (!fs.existsSync(BRIDGE_DIR)) return;
			const files = fs.readdirSync(BRIDGE_DIR).filter((f) => f.endsWith(".jsonl"));
			for (const file of files) {
				processFile(path.join(BRIDGE_DIR, file));
			}
		} catch {
			// Directory may not exist yet — that's fine.
		}
	}

	// ── Watcher lifecycle ─────────────────────────────────────────────────

	function startWatching(): void {
		try {
			fs.mkdirSync(BRIDGE_DIR, { recursive: true });
		} catch {
			// Already exists or permissions issue — continue anyway.
		}

		// Primary: fs.watch on directory (fast but unreliable on macOS)
		try {
			dirWatcher = fs.watch(BRIDGE_DIR, (_eventType, filename) => {
				if (filename && filename.endsWith(".jsonl")) {
					processFile(path.join(BRIDGE_DIR, filename));
				}
			});
			dirWatcher.on("error", () => {
				pi.log("[browser-bridge] fs.watch error, relying on polling fallback");
			});
		} catch {
			pi.log("[browser-bridge] fs.watch unavailable, relying on polling fallback");
		}

		// Fallback: 2-second polling (catches anything fs.watch misses)
		pollInterval = setInterval(scanBridgeDir, POLL_INTERVAL_MS);

		pi.log("[browser-bridge] watcher started");
	}

	function stopWatching(): void {
		if (dirWatcher) {
			dirWatcher.close();
			dirWatcher = null;
		}
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		linesRead.clear();
		pi.log("[browser-bridge] watcher stopped");
	}

	// ── Events ────────────────────────────────────────────────────────────

	pi.on("session_start", async () => {
		startWatching();
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
	});

	// ── Tool: browser_inspect (Flow B) ────────────────────────────────────

	pi.registerTool({
		name: "browser_inspect",
		label: "Browser Inspect",
		description:
			"Ask the user to pick elements in the cmux browser panel. " +
			"Activates inspection mode and waits for the user to click elements and press ESC. " +
			"Returns the picked element details (selector, role, text, href, etc.).",
		parameters: Type.Object({
			prompt: Type.Optional(
				Type.String({ description: "Message to show the user about what elements to pick" }),
			),
			timeout_ms: Type.Optional(
				Type.Number({ description: "How long to wait for picks in milliseconds (default 60000)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { prompt, timeout_ms } = params as { prompt?: string; timeout_ms?: number };
			const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;

			if (prompt) {
				ctx.ui.notify(prompt, "info");
			}

			try {
				const result = await pi.exec("cmux", ["browser", "inspect", "--wait", "--timeout-ms", String(timeout)]);
				const stdout = result.stdout ?? "";

				if (!stdout.trim()) {
					return {
						content: [{ type: "text" as const, text: "No elements were selected." }],
					};
				}

				try {
					const data: unknown = JSON.parse(stdout);
					const elements: Record<string, unknown>[] = Array.isArray(data) ? data : [data as Record<string, unknown>];

					if (elements.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No elements were selected." }],
						};
					}

					const formatted = elements.map(formatElement).join("\n");
					return {
						content: [{ type: "text" as const, text: `Picked elements:\n${formatted}` }],
						details: { count: elements.length },
					};
				} catch {
					// Couldn't parse as JSON — return raw output
					return {
						content: [{ type: "text" as const, text: `Raw inspect output:\n${stdout}` }],
					};
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);

				if (/time\s*out/i.test(msg)) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Inspection timed out. The user did not pick any elements in time.",
							},
						],
					};
				}
				if (/cancel/i.test(msg)) {
					return {
						content: [{ type: "text" as const, text: "Inspection was cancelled by the user." }],
					};
				}
				if (/no browser|not found|not available/i.test(msg)) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No browser panel is currently open. Ask the user to open one first.",
							},
						],
					};
				}

				return {
					content: [{ type: "text" as const, text: `Browser inspect failed: ${msg}` }],
				};
			}
		},
	});

	// ── Command: /inspect ─────────────────────────────────────────────────

	pi.registerCommand("inspect", {
		description: "Toggle browser inspection mode — click elements in the browser, ESC to finish",
		handler: async (_args, ctx) => {
			try {
				// Non-blocking: fire and forget
				pi.exec("cmux", ["browser", "inspect"]).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					pi.log(`[browser-bridge] /inspect background error: ${msg}`);
				});
				ctx.ui.notify("Inspection mode on — click elements in browser, ESC to finish", "info");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (/no browser|not found/i.test(msg)) {
					ctx.ui.notify("No browser panel found. Open a browser panel first.", "warning");
				} else {
					ctx.ui.notify(`Inspect failed: ${msg}`, "error");
				}
			}
		},
	});
}
