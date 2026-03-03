import Foundation
import Combine

/// Watches `/tmp/cmux-browser-bridge/` for `.listening` file changes using kqueue.
/// Publishes a set of surface IDs that have active agents.
final class BrowserBridgeWatcher: ObservableObject {
    static let shared = BrowserBridgeWatcher()

    private static let bridgeDir = "/tmp/cmux-browser-bridge"

    /// Surface IDs that currently have a `.listening` marker.
    @Published private(set) var connectedSurfaceIds: Set<String> = []

    private var source: DispatchSourceFileSystemObject?
    private var dirFD: Int32 = -1

    private init() {
        scan()
        startWatching()
    }

    deinit {
        stopWatching()
    }

    /// Write the active target surface ID and workspace ID so extensions know which agent receives picks.
    func setActiveTarget(_ surfaceId: UUID, workspaceId: UUID) {
        let targetFile = URL(fileURLWithPath: Self.bridgeDir).appendingPathComponent("active-target")
        try? FileManager.default.createDirectory(
            atPath: Self.bridgeDir,
            withIntermediateDirectories: true,
            attributes: nil
        )
        try? "\(workspaceId.uuidString):\(surfaceId.uuidString)".write(to: targetFile, atomically: true, encoding: .utf8)
    }

    /// Scan the directory for `.listening` files and update the published set.
    private func scan() {
        let dir = Self.bridgeDir
        var ids = Set<String>()
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            for entry in entries where entry.hasSuffix(".listening") {
                let id = String(entry.dropLast(".listening".count))
                ids.insert(id)
            }
        }
        if ids != connectedSurfaceIds {
            connectedSurfaceIds = ids
        }
    }

    private func startWatching() {
        // Ensure directory exists so we can open an fd on it.
        try? FileManager.default.createDirectory(
            atPath: Self.bridgeDir,
            withIntermediateDirectories: true,
            attributes: nil
        )

        dirFD = open(Self.bridgeDir, O_EVTONLY)
        guard dirFD >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: dirFD,
            eventMask: .write,
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            DispatchQueue.main.async {
                self?.scan()
            }
        }

        source.setCancelHandler { [dirFD = self.dirFD] in
            if dirFD >= 0 { close(dirFD) }
        }

        source.resume()
        self.source = source
    }

    private func stopWatching() {
        source?.cancel()
        source = nil
        dirFD = -1
    }
}
