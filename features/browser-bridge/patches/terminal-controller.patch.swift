// =============================================================================
// PATCH 1: Add route in V2 handler switch
// =============================================================================
// INSERT in Sources/TerminalController.swift
// LOCATION: In the V2 handler switch, after the "browser.input_touch" case
//           (around line 1479), before "surface.read_text":
//
//     case "browser.input_touch":
//         return v2Result(id: id, self.v2BrowserInputTouch(params: params))
//     // >>> INSERT HERE <<<
//     case "surface.read_text":

        case "browser.inspect":
            return v2Result(id: id, self.v2BrowserInspect(params: params))


// =============================================================================
// PATCH 2: Implement v2BrowserInspect and readAllPicks helper
// =============================================================================
// INSERT in Sources/TerminalController.swift
// LOCATION: After v2BrowserHighlight (around line 7830), before v2BrowserStateSave.
//
//     ... end of v2BrowserHighlight }
//     // >>> INSERT HERE <<<
//     private func v2BrowserStateSave(...

    // MARK: - browser.inspect

    private func v2BrowserInspect(params: [String: Any]) -> V2CallResult {
        let wait = v2Bool(params, "wait") ?? false
        let timeoutMs = max(1, v2Int(params, "timeout_ms") ?? 30_000)

        // Resolve the browser panel on the main thread (required for AppKit/model access).
        var resolvedSurfaceId: UUID?
        var resolvedPanel: BrowserPanel?
        var resolvedWorkspace: Workspace?
        var resolveError: V2CallResult?

        v2MainSync {
            guard let tabManager = v2ResolveTabManager(params: params) else {
                resolveError = .err(code: "unavailable", message: "TabManager not available", data: nil)
                return
            }
            guard let ws = v2ResolveWorkspace(params: params, tabManager: tabManager) else {
                resolveError = .err(code: "not_found", message: "Workspace not found", data: nil)
                return
            }
            let surfaceId = v2UUID(params, "surface_id") ?? ws.focusedPanelId
            guard let surfaceId else {
                resolveError = .err(code: "not_found", message: "No focused browser surface", data: nil)
                return
            }
            guard let browserPanel = ws.browserPanel(for: surfaceId) else {
                resolveError = .err(code: "invalid_params", message: "Surface is not a browser", data: ["surface_id": surfaceId.uuidString])
                return
            }
            resolvedSurfaceId = surfaceId
            resolvedPanel = browserPanel
            resolvedWorkspace = ws
        }

        if let resolveError { return resolveError }
        guard let surfaceId = resolvedSurfaceId,
              let browserPanel = resolvedPanel,
              let ws = resolvedWorkspace else {
            return .err(code: "internal_error", message: "Failed to resolve browser panel", data: nil)
        }

        // Build the bridge file path: /tmp/cmux-bridge/<surfaceId>.jsonl
        let bridgeFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmux-bridge")
            .appendingPathComponent("\(surfaceId.uuidString).jsonl")

        // Ensure the bridge directory exists.
        try? FileManager.default.createDirectory(
            at: bridgeFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        // Clear any stale bridge data from a previous session.
        try? FileManager.default.removeItem(at: bridgeFile)

        if !wait {
            // Non-wait mode: enable inspection and return immediately.
            DispatchQueue.main.async {
                browserPanel.inspectionSurfaceId = surfaceId.uuidString
                browserPanel.enableInspectionMode()
            }
            return .ok([
                "status": "enabled",
                "workspace_id": ws.id.uuidString,
                "workspace_ref": v2Ref(kind: .workspace, uuid: ws.id),
                "surface_id": surfaceId.uuidString,
                "surface_ref": v2Ref(kind: .surface, uuid: surfaceId),
                "bridge_file": bridgeFile.path
            ])
        }

        // Wait mode: enable inspection, then poll until user finishes (ESC) or timeout.
        // CRITICAL: The polling loop runs OFF the main thread to avoid deadlocking the app.
        //           We only dispatch to main for the initial enable and final disable.
        DispatchQueue.main.async {
            browserPanel.inspectionSurfaceId = surfaceId.uuidString
            browserPanel.enableInspectionMode()
        }

        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        let pollInterval: TimeInterval = 0.2
        var timedOut = true

        while Date() < deadline {
            // Check if the user has finished inspection (pressed ESC).
            var isActive = true
            v2MainSync {
                isActive = browserPanel.isInspectionModeActive
            }
            if !isActive {
                timedOut = false
                break
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }

        if timedOut {
            // Disable inspection mode on timeout so the overlay doesn't linger.
            DispatchQueue.main.async {
                browserPanel.disableInspectionMode()
            }
            // Brief pause to let the disable take effect and any final writes flush.
            Thread.sleep(forTimeInterval: 0.1)
        }

        // Read all picks from the bridge JSONL file.
        let picksResult = readAllPicks(from: bridgeFile)

        if timedOut {
            var data: [String: Any] = [
                "timeout_ms": timeoutMs,
                "workspace_id": ws.id.uuidString,
                "workspace_ref": v2Ref(kind: .workspace, uuid: ws.id),
                "surface_id": surfaceId.uuidString,
                "surface_ref": v2Ref(kind: .surface, uuid: surfaceId),
            ]
            if let picks = picksResult["picks"] as? [Any], !picks.isEmpty {
                data["partial_picks"] = picks
            }
            return .err(code: "timeout", message: "Inspection timed out before user finished", data: data)
        }

        var result: [String: Any] = [
            "status": "completed",
            "workspace_id": ws.id.uuidString,
            "workspace_ref": v2Ref(kind: .workspace, uuid: ws.id),
            "surface_id": surfaceId.uuidString,
            "surface_ref": v2Ref(kind: .surface, uuid: surfaceId),
        ]
        if let picks = picksResult["picks"] as? [Any] {
            result["picks"] = picks
            result["pick_count"] = picks.count
        }
        return .ok(result)
    }

    /// Read all element picks from a JSONL bridge file.
    /// Each line is expected to be a valid JSON object written by the inspection overlay.
    /// Returns `{"picks": [...]}` with parsed entries; malformed lines are silently skipped.
    private func readAllPicks(from url: URL) -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return ["picks": [] as [Any]]
        }
        guard let data = try? Data(contentsOf: url),
              let contents = String(data: data, encoding: .utf8) else {
            return ["picks": [] as [Any]]
        }
        let lines = contents.components(separatedBy: .newlines)
        var picks: [[String: Any]] = []
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            guard let lineData = trimmed.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: lineData, options: []) as? [String: Any] else {
                continue // skip malformed lines
            }
            picks.append(parsed)
        }
        return ["picks": picks]
    }
