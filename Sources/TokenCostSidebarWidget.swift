import SwiftUI

/// Sidebar widget showing token cost for all agents in the window.
/// Always visible at the bottom of the sidebar. Each agent (pane/surface) gets its own line item.
struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = true

    /// Flat list of all agent entries across all workspaces.
    private var agentEntries: [(workspace: Workspace, surfaceId: String, usage: TokenUsageState)] {
        _ = tabManager.tokenUsageGeneration
        var result: [(Workspace, String, TokenUsageState)] = []
        for ws in tabManager.tabs {
            for (surfaceId, usage) in ws.tokenUsageByAgent.sorted(by: { $0.key < $1.key }) {
                result.append((ws, surfaceId, usage))
            }
        }
        return result
    }

    private var totalCost: Double {
        agentEntries.reduce(0) { $0 + $1.usage.cost }
    }

    private var totalTokens: Int {
        agentEntries.reduce(0) { $0 + $1.usage.totalTokens }
    }

    private var formattedTotalCost: String {
        totalCost < 0.01 ? String(format: "$%.4f", totalCost) : String(format: "$%.2f", totalCost)
    }

    private var formattedTotalTokens: String {
        if totalTokens >= 1_000_000 { return String(format: "%.1fM tok", Double(totalTokens) / 1_000_000) }
        if totalTokens >= 1_000 { return String(format: "%.0fk tok", Double(totalTokens) / 1_000) }
        return "\(totalTokens) tok"
    }

    var body: some View {
        // Read generation to establish SwiftUI dependency
        let _ = tabManager.tokenUsageGeneration
        let entries = agentEntries

        if !entries.isEmpty {
            VStack(spacing: 0) {
                Color(nsColor: .separatorColor)
                    .frame(height: 1)

                // Header: clickable aggregate row
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "dollarsign.circle")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                        Text(formattedTotalCost)
                            .font(.system(size: 11, weight: .semibold))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .animation(.default, value: totalCost)
                        if totalTokens > 0 {
                            Text("·")
                                .foregroundStyle(.secondary)
                            Text(formattedTotalTokens)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if entries.count > 1 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        }
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)

                // Per-agent breakdown (only shown when multiple agents)
                if isExpanded && entries.count > 1 {
                    VStack(spacing: 2) {
                        ForEach(entries, id: \.surfaceId) { entry in
                            TokenCostAgentRow(
                                workspaceTitle: entry.workspace.title,
                                usage: entry.usage
                            )
                        }
                    }
                    .padding(.bottom, 6)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }
}

// MARK: - Per-agent row

private struct TokenCostAgentRow: View {
    let workspaceTitle: String
    let usage: TokenUsageState

    var body: some View {
        HStack(spacing: 4) {
            Text(workspaceTitle)
                .font(.system(size: 9))
                .lineLimit(1)
                .truncationMode(.tail)
            if let model = usage.displayModelName {
                Text("·")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                Text(model)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer()
            Text(usage.formattedCost)
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .contentTransition(.numericText())
                .animation(.default, value: usage.cost)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
    }
}
