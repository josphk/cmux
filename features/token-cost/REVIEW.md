# Plan Review: Token Cost Sidebar Widget

## 1. Key Optimizations — Cut the Moving Parts

**Kill Option A entirely.** The plan presents `report_meta` (Option A) and `report_tokens` (Option B) as alternatives, then builds Phase 1 around Option A anyway. This is a waste. `report_meta` puts a cost string into the per-workspace metadata rows — it mixes with git branches, status entries, and arbitrary agent metadata. You can't aggregate across workspaces, you can't format it differently, and you'll throw it all away in Phase 2. **Start with Option B. Skip Phase 1.**

**The `panelTokenUsage: [UUID: TokenUsageState]` per-panel tracking is premature.** The plan adds per-panel token tracking plus an `aggregateTokenUsage` computed property. In practice, agents report per-session, not per-split-pane. A workspace running pi in one pane and a browser in another doesn't need per-panel cost aggregation. **Ship with `tokenUsage: TokenUsageState?` on Workspace only.** Add per-panel later if a real use case appears. This eliminates the `aggregateTokenUsage` computed property, the `panelTokenUsage` dictionary, panel-resolution logic in the socket handler, and the `--panel=Y` flag.

**The extension shells out to `nc -U`.** That's fragile — `nc` variants differ across macOS versions, and `execSync` blocks the agent event loop. The extension should open a Unix socket directly via Node's `net.connect()`:

```typescript
import { createConnection } from "net";
const sock = createConnection(socketPath);
sock.write(`report_tokens --cost=${cost.toFixed(4)} --input=${input} --output=${output}\n`);
sock.end();
```

No shell escaping, no subprocess overhead, no `nc` compatibility issues.

## 2. Simplification — Collapse Phases

The 4-phase plan is over-staged. Here's what I'd ship:

| Original | Proposed | Why |
|----------|----------|-----|
| Phase 1 (report_meta MVP) | **Delete** | Throwaway work. Zero reuse. |
| Phase 2 (model + command) | **Phase 1** | This is the real MVP. ~3 hours. |
| Phase 3 (widget) | **Merge into Phase 1** | The widget is trivial once the model exists. Add 1–2 hours. |
| Phase 4 (polish + agents) | **Phase 2** | Ship after validating Phase 1 works end-to-end. |

**Concrete Phase 1 (ship in one PR):**
1. `TokenUsageState` struct (simplified — no per-panel, no `AgentType` enum yet)
2. `@Published var tokenUsage: TokenUsageState?` on `Workspace`
3. `report_tokens` + `clear_tokens` socket commands (skip `list_tokens` — use `list_meta` pattern if needed later)
4. `TokenCostSidebarWidget` in `VerticalTabsSidebar`
5. Pi extension `cmux-token-reporter.ts`

That's 3 new files, 2 file edits. One PR, one review cycle.

**Things to defer to Phase 2:**
- `AgentType` enum and colored dots (you won't have multiple agent types initially)
- Per-panel tracking
- `list_tokens` command
- Session persistence of token stats
- `CMUX_SOCKET` env var injection (use well-known path scan for now)
- Cost alerts / budgets

## 3. Breaking Changes — Risk Assessment

**Adding `@Published var tokenUsage` to `Workspace` is safe but watch the weight.** Workspace already has ~20 `@Published` properties. Each one triggers SwiftUI diff checks on every mutation of *any* published property on that `ObservableObject`. `tokenUsage` will update on every agent turn (could be every few seconds during active coding). This is fine because:
- The existing `statusEntries`, `logEntries`, and `progress` already update at similar frequencies
- The socket threading policy (off-main parse, `main.async` mutation) is already established

**However:** Make `TokenUsageState` a struct conforming to `Equatable` (the plan already does this). SwiftUI will skip re-renders when the value hasn't changed. The debounce in the extension (skip if cost delta < $0.001) is good — keep it.

**Sidebar layout change is low risk.** The insertion point is clean:

```swift
GeometryReader { ... }   // existing
TokenCostSidebarWidget()  // new — between these two
SidebarDevFooter / UpdatePill  // existing
```

The `GeometryReader` fills available space minus the footer. Adding the widget between them shrinks the scroll area by ~30px. **Risk:** if the sidebar is very short (e.g., user has many tabs + small window), the widget competes with `UpdatePill` for space. **Mitigation:** Hide the widget when sidebar height < threshold, or make it collapse into a single line (just `$0.42`).

**Session persistence is a non-issue for now.** The plan correctly defers this. Token stats are ephemeral — they reset on app restart. No migration needed.

## 4. UX Improvements

**When no agents are running:** The plan's `if !activeUsages.isEmpty` conditional is correct — widget is invisible. **But add a subtle empty state after first use.** Once a user has seen token costs in a session, going to `$0.00` is better than disappearing entirely. Track a `hasEverReportedTokens` flag on the session. Show a grayed-out `$0.00` when agents finish, so users know the feature exists and can reference the final cost.

**Animate cost updates:** Yes, but subtly. Use `.contentTransition(.numericText())` on the cost label (available macOS 14+). This gives a nice digit-rolling effect without any manual animation code:

```swift
Text(formattedTotalCost)
    .contentTransition(.numericText())
    .animation(.default, value: totalCost)
```

**Cost-per-minute rate:** Don't show it. It's noisy, varies wildly based on agent activity, and creates anxiety without being actionable. If someone wants it, they can derive it from the total cost and session duration.

**Model name:** **Yes, show this.** It's more useful than `AgentType`. Add a `--model=` string flag to `report_tokens`:

```
report_tokens --cost=0.45 --input=50000 --output=10000 --model=claude-sonnet-4-20250514
```

Display it in the expanded view as `claude-sonnet-4 · $0.25` per workspace. Truncate model names to something human-readable (strip dates, shorten prefixes).

**One more UX point:** The expand/collapse chevron is overkill for v1. If there's only one workspace with token data, don't show the chevron or per-workspace breakdown at all. Only show the expandable list when `activeUsages.count > 1`. For a single workspace, just show the total.

## 5. Testing Strategy

**Socket command unit test (highest priority):**
Add to the existing VM-based test suite. Follows the same pattern as `test_ctrl_socket.py`:

```python
# tests/test_token_reporting.py
def test_report_tokens_basic():
    """report_tokens stores structured data and returns OK"""
    result = send_socket("report_tokens --cost=0.42 --input=50000 --output=10000")
    assert result == "OK"

def test_report_tokens_missing_cost():
    """report_tokens without --cost returns error"""
    result = send_socket("report_tokens --input=50000")
    assert "ERROR" in result

def test_clear_tokens():
    """clear_tokens resets token state"""
    send_socket("report_tokens --cost=0.42 --input=50000 --output=10000")
    result = send_socket("clear_tokens")
    assert result == "OK"
```

Run via the existing VM infrastructure:
```bash
ssh cmux-vm '... && python3 tests/test_token_reporting.py'
```

**Integration test with actual pi extension:**
This is manual but important. Run the extension in a cmux Debug build, start a pi session, make a few queries, and verify the sidebar widget updates. Log verification:
```bash
tail -f /tmp/cmux-debug-token-test.log | grep token
```

**SwiftUI widget visual test:**
Don't write one. The widget is too simple to justify UI test infrastructure. Manual visual check during the tagged debug build is sufficient. If you want automated coverage later, add a UI test that verifies the widget appears after sending `report_tokens` via socket (similar to `UpdatePillUITests`).

**What you don't need to test:**
- Per-panel aggregation (you're not building it in v1)
- Session persistence (deferred)
- Multi-agent scenarios (deferred)

## Summary of Recommended Changes

1. **Delete Phase 1.** Start with `report_tokens` (Option B). No `report_meta` detour.
2. **Merge Phases 2+3 into a single Phase 1.** Model + command + widget in one PR.
3. **Drop `panelTokenUsage` and per-panel tracking.** Single `tokenUsage` on Workspace.
4. **Drop `AgentType` enum.** Add `--model=` string flag instead. Render model name, not agent brand.
5. **Use Node `net.connect()` in the extension**, not `execSync` + `nc -U`.
6. **Add `hasEverReportedTokens` session flag** so the widget shows `$0.00` after agents finish rather than disappearing.
7. **Add `.contentTransition(.numericText())`** for cost animation.
8. **Skip expand/collapse when only 1 workspace has data.**
9. **Add `test_token_reporting.py`** to the VM test suite, following `test_ctrl_socket.py` patterns.
10. **Add min-height guard** on the widget so it hides gracefully in cramped sidebars.
