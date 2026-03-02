import SwiftUI

/// Sidebar widget showing token cost for all agents in the window.
/// Always visible at the bottom of the sidebar. Each agent (pane/surface) gets its own line item.
struct TokenCostSidebarWidget: View {
    @EnvironmentObject var tabManager: TabManager
    @State private var isExpanded = false
    @State private var hoverSuppressed = false

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
        agentEntries.reduce(0) { $0 + $1.usage.effectiveCost }
    }

    private var totalTokens: Int {
        agentEntries.reduce(0) { $0 + $1.usage.totalTokens }
    }

    private var activeCount: Int {
        agentEntries.filter(\.usage.isActive).count
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
        let agentCount = entries.count

        VStack(spacing: 0) {
            Color(nsColor: .separatorColor)
                .frame(height: 1)

            // Header: always visible, shows aggregate
            HStack(alignment: .center, spacing: 4) {
                Image(systemName: "dollarsign.circle")
                    .font(.system(size: 11, weight: .medium))
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
                if agentCount > 0 {
                    Text("\(agentCount)")
                        .font(.system(size: 9, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(
                            Capsule()
                                .fill(Color(nsColor: .separatorColor).opacity(0.6))
                        )
                        .contentTransition(.numericText())
                        .animation(.default, value: agentCount)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .animation(.easeInOut(duration: 0.2), value: isExpanded)
            }
            .foregroundStyle(totalCost > 0 ? .primary : .secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .onTapGesture {
                hoverSuppressed = true
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    hoverSuppressed = false
                }
            }

            // Per-agent breakdown — clipped to simulate overflow-hidden
            VStack(spacing: 0) {
                ForEach(entries, id: \.surfaceId) { entry in
                    TokenCostAgentRow(
                        workspaceTitle: entry.workspace.title,
                        usage: entry.usage,
                        hoverSuppressed: hoverSuppressed,
                        onTap: entry.usage.isActive ? {
                            focusAgent(workspace: entry.workspace, surfaceId: entry.surfaceId)
                        } : nil
                    )
                }
            }
            .padding(.bottom, isExpanded ? 6 : 0)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxHeight: isExpanded ? 500 : 0, alignment: .top)
            .clipped()
            .allowsHitTesting(isExpanded)
            .animation(.easeInOut(duration: 0.2), value: isExpanded)
            .animation(.easeInOut(duration: 0.2), value: agentCount)
        }
    }

    private func focusAgent(workspace: Workspace, surfaceId: String) {
        guard let surfaceUUID = UUID(uuidString: surfaceId) else { return }
        if tabManager.selectedTabId != workspace.id {
            tabManager.selectWorkspace(workspace)
        }
        tabManager.focusSurface(tabId: workspace.id, surfaceId: surfaceUUID)
    }
}

// MARK: - Per-agent row

private struct TokenCostAgentRow: View {
    let workspaceTitle: String
    let usage: TokenUsageState
    var hoverSuppressed: Bool = false
    var onTap: (() -> Void)?

    @State private var isHovered = false

    private var isInteractive: Bool { onTap != nil }
    private var showHover: Bool { isHovered && !hoverSuppressed && isInteractive }

    var body: some View {
        HStack(spacing: 4) {
            // Status dot: green = active, gray outline = dead
            Circle()
                .fill(usage.isActive ? Color.green : Color.clear)
                .overlay(
                    Circle()
                        .strokeBorder(usage.isActive ? Color.clear : Color.gray.opacity(0.5), lineWidth: 1)
                )
                .frame(width: 6, height: 6)

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
                .animation(.default, value: usage.effectiveCost)
        }
        .foregroundStyle(showHover ? .primary : .secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(Color(nsColor: .white).opacity(showHover ? 0.06 : 0))
        )
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .animation(.easeInOut(duration: 0.15), value: showHover)
        .onHover { hovering in
            isHovered = isInteractive ? hovering : false
        }
        .onTapGesture {
            onTap?()
        }
    }
}
