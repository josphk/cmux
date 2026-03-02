import Foundation

/// Structured token usage and cost state reported by coding agents (pi, Claude Code, etc.)
/// via the `report_tokens` socket command. Stored on `Workspace.tokenUsage`.
struct TokenUsageState: Equatable {
    var input: Int = 0
    var output: Int = 0
    var cacheRead: Int = 0
    var cacheWrite: Int = 0
    var totalTokens: Int = 0
    var cost: Double = 0.0           // USD
    var model: String?               // e.g. "claude-sonnet-4-20250514"
    var lastUpdated: Date = Date()

    var formattedCost: String {
        if cost < 0.01 {
            return String(format: "$%.4f", cost)
        } else {
            return String(format: "$%.2f", cost)
        }
    }

    var formattedTokens: String {
        let total = input + output + cacheRead + cacheWrite
        if total >= 1_000_000 {
            return String(format: "%.1fM", Double(total) / 1_000_000)
        } else if total >= 1_000 {
            return String(format: "%.0fk", Double(total) / 1_000)
        }
        return "\(total)"
    }

    /// Human-readable model name: strips date suffixes and common prefixes.
    /// "claude-sonnet-4-20250514" → "claude-sonnet-4"
    /// "gpt-4o-2024-08-06" → "gpt-4o"
    var displayModelName: String? {
        guard let model, !model.isEmpty, model != "unknown" else { return nil }
        let parts = model.split(separator: "-")
        // Drop trailing segment if it looks like a date (8 digits)
        if let last = parts.last, last.count == 8, last.allSatisfy(\.isNumber) {
            return parts.dropLast().joined(separator: "-")
        }
        return model
    }
}
