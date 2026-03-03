/**
 * cmux Browser Bridge Extension
 *
 * Bridges browser element picks from cmux inspection mode into the pi agent conversation.
 *
 * Flow A (user-initiated): Watches /tmp/cmux-browser-bridge/*.jsonl for new picks and injects them
 *         as numbered references (<1>, <2>, ...) that the user can reference in their prompt.
 * Flow B (agent-initiated): Provides a `browser_inspect` tool the LLM can call to request
 *         the user pick elements.
 * Command: `/inspect` toggles inspection mode in the cmux browser panel.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const BRIDGE_DIR = "/tmp/cmux-browser-bridge";
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
 * Format a picked element record as an XML-like tag with a pick ID.
 *
 * Example output:
 *   <browser-element pick="<1>" selector="form > button.primary-submit" role="button" text="Submit" page="http://localhost:3000" />
 */
function formatElement(el: Record<string, unknown>, pickId: number): string {
	const attrs: string[] = [`pick="<${pickId}>"`];

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
	const surfaceId = process.env.CMUX_SURFACE_ID!;

	/** Path to this agent's bridge file (scoped by its own surface ID). */
	const bridgeFile = path.join(BRIDGE_DIR, `${surfaceId}.jsonl`);
	let linesRead = 0;
	let dirWatcher: fs.FSWatcher | null = null;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// ── Pick state (resets per agent turn) ────────────────────────────────
	let pickCounter = 0;
	/** Pending picks indexed by ID. Only referenced picks are sent to the LLM. */
	const pendingPicks = new Map<number, { formatted: string }>();

	// ── ANSI helpers for blue styling ─────────────────────────────────────
	const BLUE = "\x1b[38;5;33m";    // bright blue foreground
	const BLUE_DIM = "\x1b[38;5;67m"; // muted blue
	const BLUE_BG = "\x1b[48;5;17m"; // dark blue background
	const BOLD = "\x1b[1m";
	const RESET = "\x1b[0m";

	/** Update the picks widget below the editor. */
	function updatePicksWidget(): void {
		if (!uiRef) return;
		if (pendingPicks.size === 0) {
			uiRef.setWidget("browser-picks", undefined);
			return;
		}

		uiRef.setWidget("browser-picks", (_tui, _theme) => {
			let cachedLines: string[] | null = null;
			return {
				invalidate() { cachedLines = null; },
				render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const pad = (s: string) => `${BLUE_BG} ${s}${RESET}${BLUE_BG}${" ".repeat(Math.max(0, width - visibleLen(s) - 2))} ${RESET}`;

					for (const [id, pick] of pendingPicks) {
						if (lines.length > 0) lines.push(""); // spacing between picks
						lines.push(pad(`${BOLD}${BLUE}<${id}>${RESET}${BLUE_BG}  ${BLUE_DIM}${pick.formatted}${RESET}`));
					}
					cachedLines = lines;
					return lines;
				},
			};
		}, { placement: "belowEditor" });
	}

	/** Calculate visible length of a string (excluding ANSI escapes). */
	function visibleLen(s: string): number {
		return s.replace(/\x1b\[[0-9;]*m/g, "").length;
	}

	// ── Bridge file processing ────────────────────────────────────────────

	/** Read new lines from this agent's bridge file and deliver them to the chat. */
	function processBridgeFile(): void {
		if (!uiRef) return;
		try {
			if (!fs.existsSync(bridgeFile)) return;
			const content = fs.readFileSync(bridgeFile, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim());

			if (lines.length <= linesRead) return;

			const newLines = lines.slice(linesRead);
			linesRead = lines.length;

			for (const line of newLines) {
				try {
					const el = JSON.parse(line) as Record<string, unknown>;
					pickCounter++;
					const pickId = pickCounter;
					const formatted = formatElement(el, pickId);

					// Store for later — full data only injected if referenced in the user message.
					pendingPicks.set(pickId, { formatted });
					updatePicksWidget();

					// Auto-append the pick reference to the editor.
					const currentText = uiRef.getEditorText();
					const separator = currentText.length > 0 ? " " : "";
					uiRef.setEditorText(`${currentText}${separator}<${pickId}>`);
				} catch {
					console.log(`[browser-bridge] malformed JSONL line: ${line}`);
				}
			}
		} catch {
			// File may have been deleted or is temporarily inaccessible — skip silently.
		}
	}

	// ── Watcher lifecycle ─────────────────────────────────────────────────

	/** Presence marker so the Swift side knows an agent is listening for this surface. */
	const presenceFile = path.join(BRIDGE_DIR, `${surfaceId}.listening`);

	function startWatching(): void {
		try {
			fs.mkdirSync(BRIDGE_DIR, { recursive: true });
		} catch {
			// Already exists or permissions issue — continue anyway.
		}

		// Skip any lines already in the file from a previous session.
		try {
			if (fs.existsSync(bridgeFile)) {
				const existing = fs.readFileSync(bridgeFile, "utf-8");
				linesRead = existing.split("\n").filter((l) => l.trim()).length;
			}
		} catch {}

		// Write presence marker so cmux knows we're listening.
		try {
			fs.writeFileSync(presenceFile, `${process.pid}\n`, "utf-8");
		} catch {
			console.log("[browser-bridge] failed to write presence marker");
		}

		// Primary: fs.watch on directory, filter for our file
		try {
			dirWatcher = fs.watch(BRIDGE_DIR, (_eventType, filename) => {
				if (filename === `${surfaceId}.jsonl`) {
					processBridgeFile();
				}
			});
			dirWatcher.on("error", () => {
				console.log("[browser-bridge] fs.watch error, relying on polling fallback");
			});
		} catch {
			console.log("[browser-bridge] fs.watch unavailable, relying on polling fallback");
		}

		// Fallback: 2-second polling (catches anything fs.watch misses)
		pollInterval = setInterval(processBridgeFile, POLL_INTERVAL_MS);

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
		// Remove presence marker.
		try { fs.unlinkSync(presenceFile); } catch {}

	}

	// ── Active target tracking ─────────────────────────────────────────────

	const activeTargetFile = path.join(BRIDGE_DIR, "active-target");
	let targetWatcher: fs.FSWatcher | null = null;
	let uiRef: {
		setStatus: (key: string, text: string | undefined) => void;
		setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => void;
		getEditorText: () => string;
		setEditorText: (text: string) => void;
	} | null = null;

	const inspectingFile = path.join(BRIDGE_DIR, "inspecting");

	const workspaceId = process.env.CMUX_WORKSPACE_ID!;

	function checkActiveTarget(): void {
		if (!uiRef) return;
		try {
			const isInspecting = fs.existsSync(inspectingFile);
			const content = fs.readFileSync(activeTargetFile, "utf-8").trim();
			// Format: workspaceId:surfaceId
			const [targetWorkspace, targetSurface] = content.split(":");
			if (isInspecting && targetSurface === surfaceId && targetWorkspace === workspaceId) {
				uiRef.setStatus("browser-bridge", "● Ready for browser picks");
			} else {
				uiRef.setStatus("browser-bridge", undefined);
			}
		} catch {
			uiRef.setStatus("browser-bridge", undefined);
		}
	}

	function startTargetWatcher(): void {
		if (targetWatcher) return;
		try {
			targetWatcher = fs.watch(BRIDGE_DIR, (_eventType, filename) => {
				if (filename === "active-target" || filename === "inspecting") checkActiveTarget();
			});
			targetWatcher.on("error", () => {});
		} catch {}
	}

	// ── Events ────────────────────────────────────────────────────────────

	// Start watching immediately (extension may load after session_start fires).
	startWatching();
	startTargetWatcher();

	pi.on("session_start", async (_event, ctx) => {
		startWatching();
		uiRef = ctx.ui;
		checkActiveTarget();
		startTargetWatcher();
	});

	// Capture ctx on first turn if session_start was missed.
	pi.on("turn_start", async (_event, ctx) => {
		if (!uiRef) {
			uiRef = ctx.ui;
			checkActiveTarget();
		}
	});

	// Inject only referenced picks into the LLM context, then reset.
	pi.on("before_agent_start", async (event) => {
		let result: { message: { customType: string; content: string; display: boolean } } | undefined;

		if (pendingPicks.size > 0) {
			// Find all <N> references in the user's prompt.
			const referencedIds: number[] = [];
			const refPattern = /<(\d+)>/g;
			let match: RegExpExecArray | null;
			while ((match = refPattern.exec(event.prompt)) !== null) {
				const id = parseInt(match[1], 10);
				if (pendingPicks.has(id)) {
					referencedIds.push(id);
				}
			}

			if (referencedIds.length > 0) {
				const lines = referencedIds.map((id) => pendingPicks.get(id)!.formatted);
				result = {
					message: {
						customType: "browser-picks-context",
						content: lines.join("\n"),
						display: false,
					},
				};
			}
		}

		// Reset for next round of picks.
		pickCounter = 0;
		pendingPicks.clear();
		updatePicksWidget();

		return result;
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
		if (targetWatcher) { targetWatcher.close(); targetWatcher = null; }
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

					const formatted = elements.map((el, i) => formatElement(el, i + 1)).join("\n");
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
					console.log(`[browser-bridge] /inspect background error: ${msg}`);
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
