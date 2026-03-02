import Combine
import SwiftUI

/// Sidebar widget showing token cost for all workspaces in the window.
/// Always visible at the bottom of the sidebar, above the update pill / dev footer.
struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = true
    /// Bumped whenever any workspace publishes a change, forcing the header to re-read costs.
    @State private var changeGeneration: UInt64 = 0

    /// Merged publisher that fires when any workspace in the tab list changes.
    private var anyWorkspaceChanged: AnyPublisher<Void, Never> {
        let publishers = tabManager.tabs.map { $0.objectWillChange.map { _ in () } }
        return Publishers.MergeMany(publishers).eraseToAnyPublisher()
    }

    private var totalCost: Double {
        _ = changeGeneration // force dependency on the generation counter
        return tabManager.tabs.compactMap(\.tokenUsage?.cost).reduce(0, +)
    }

    private var totalTokens: Int {
        _ = changeGeneration
        return tabManager.tabs.compactMap(\.tokenUsage?.totalTokens).reduce(0, +)
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

            // Per-workspace breakdown
            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(tabManager.tabs) { ws in
                        TokenCostWorkspaceRow(workspace: ws)
                    }
                }
                .padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .onReceive(anyWorkspaceChanged) { _ in
            changeGeneration &+= 1
        }
    }
}

// MARK: - Per-workspace row

/// Each row subscribes to its own workspace via @ObservedObject,
/// so SwiftUI re-renders when tokenUsage changes on that workspace.
private struct TokenCostWorkspaceRow: View {
    @ObservedObject var workspace: Workspace

    private var usage: TokenUsageState? { workspace.tokenUsage }

    var body: some View {
        HStack(spacing: 4) {
            Text(workspace.title)
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
