import SwiftUI

/// Sidebar widget showing token cost for all workspaces in the window.
/// Always visible at the bottom of the sidebar, above the update pill / dev footer.
struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = true

    private var workspaceEntries: [(workspace: Workspace, usage: TokenUsageState?)] {
        tabManager.tabs.map { ws in (workspace: ws, usage: ws.tokenUsage) }
    }

    private var totalCost: Double {
        tabManager.tabs.compactMap(\.tokenUsage?.cost).reduce(0, +)
    }

    private var totalTokens: Int {
        tabManager.tabs.compactMap(\.tokenUsage?.totalTokens).reduce(0, +)
    }

    private var formattedTotalCost: String {
        if totalCost < 0.01 {
            return String(format: "$%.4f", totalCost)
        } else {
            return String(format: "$%.2f", totalCost)
        }
    }

    private var formattedTotalTokens: String {
        if totalTokens >= 1_000_000 {
            return String(format: "%.1fM tok", Double(totalTokens) / 1_000_000)
        } else if totalTokens >= 1_000 {
            return String(format: "%.0fk tok", Double(totalTokens) / 1_000)
        }
        return "\(totalTokens) tok"
    }

    var body: some View {
        VStack(spacing: 0) {
            // Thin separator
            Color(nsColor: .separatorColor)
                .frame(height: 1)

            // Header: aggregate total, always visible
            headerRow

            // Per-workspace breakdown
            if isExpanded {
                perWorkspaceList
            }
        }
    }

    // MARK: - Header

    private var headerRow: some View {
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
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(totalCost > 0 ? .primary : .secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    // MARK: - Per-workspace list

    private var perWorkspaceList: some View {
        VStack(spacing: 2) {
            ForEach(workspaceEntries, id: \.workspace.id) { ws, usage in
                HStack(spacing: 4) {
                    Text(ws.title)
                        .font(.system(size: 9))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let model = usage?.displayModelName {
                        Text("·")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                        Text(model)
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(usage?.formattedCost ?? "$0.00")
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(.default, value: usage?.cost ?? 0)
                }
                .foregroundStyle(.secondary.opacity(usage != nil ? 1.0 : 0.5))
                .padding(.horizontal, 10)
                .padding(.vertical, 2)
            }
        }
        .padding(.bottom, 6)
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}
