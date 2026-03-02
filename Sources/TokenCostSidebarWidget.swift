import SwiftUI

/// Sidebar widget showing aggregate token cost across active workspaces.
/// Appears at the bottom of the sidebar, above the update pill / dev footer.
struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = false
    @State private var hasEverReportedTokens = false

    private var activeUsages: [(workspace: Workspace, usage: TokenUsageState)] {
        tabManager.tabs.compactMap { ws in
            ws.tokenUsage.map { (ws, $0) }
        }
    }

    private var totalCost: Double {
        activeUsages.reduce(0) { $0 + $1.usage.cost }
    }

    private var totalTokens: Int {
        activeUsages.reduce(0) { $0 + $1.usage.totalTokens }
    }

    private var shouldShow: Bool {
        !activeUsages.isEmpty || hasEverReportedTokens
    }

    private var showExpandControls: Bool {
        activeUsages.count > 1
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
        if shouldShow {
            VStack(spacing: 0) {
                // Thin separator
                Color(nsColor: .separatorColor)
                    .frame(height: 1)

                if activeUsages.isEmpty {
                    // Grayed-out placeholder when no active usages
                    inactiveRow
                } else if showExpandControls {
                    multiWorkspaceView
                } else {
                    singleWorkspaceView
                }
            }
            .onChange(of: activeUsages.count) { newCount in
                if newCount > 0 {
                    hasEverReportedTokens = true
                }
            }
        }
    }

    // MARK: - Inactive (grayed out)

    private var inactiveRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "dollarsign.circle")
                .font(.system(size: 10))
            Text("$0.00")
                .font(.system(size: 11, weight: .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(.secondary.opacity(0.5))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Single workspace

    private var singleWorkspaceView: some View {
        let usage = activeUsages[0].usage
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "dollarsign.circle")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text(usage.formattedCost)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .animation(.default, value: usage.cost)
                Text(usage.formattedTokens)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            if let model = usage.displayModelName {
                Text(model)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Multi workspace

    private var multiWorkspaceView: some View {
        VStack(spacing: 0) {
            // Aggregate header row
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "dollarsign.circle")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Text(formattedTotalCost)
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(.default, value: totalCost)
                    Text(formattedTotalTokens)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            // Expanded per-workspace rows
            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(activeUsages, id: \.workspace.id) { ws, usage in
                        HStack(spacing: 4) {
                            Text(ws.title)
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
                                .font(.system(size: 10, weight: .semibold))
                                .monospacedDigit()
                                .contentTransition(.numericText())
                                .animation(.default, value: usage.cost)
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 2)
                    }
                }
                .padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
}
