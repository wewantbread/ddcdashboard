import AppKit
import Foundation
import Testing
@testable import OpenClaw

/// Captures the real on-screen Talk panel after the reported sequence.
/// Window scoped, so only the overlay is photographed. Set OPENCLAW_TALK_SHOT_DIR.
@Suite(.serialized)
@MainActor
struct TalkOverlayScreenshotProbe {
    @Test func `photograph the overlay after an interrupted dismissal`() async {
        guard let dir = ProcessInfo.processInfo.environment["OPENCLAW_TALK_SHOT_DIR"] else { return }
        NSApplication.shared.setActivationPolicy(.accessory)

        let controller = TalkOverlayController()
        controller.present()
        controller.updatePhase(.listening)
        controller.updateLevel(0.6)
        try? await Task.sleep(nanoseconds: 700_000_000)
        Self.shoot(controller, dir: dir, name: "1-presented")

        controller.dismiss()
        controller.present()
        try? await Task.sleep(nanoseconds: 900_000_000)
        Self.shoot(controller, dir: dir, name: "2-after-interrupted-dismissal")
    }

    static func shoot(_ controller: TalkOverlayController, dir: String, name: String) {
        guard let panel = controller.window else { return }
        let id = panel.windowNumber
        print("SHOT \(name): windowNumber=\(id) visible=\(panel.isVisible) alpha=\(panel.alphaValue)")
        guard id > 0 else {
            print("SHOT \(name): panel is not on screen, nothing to photograph")
            return
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        // -l<id> restricts the capture to this one window. -o drops the shadow.
        task.arguments = ["-x", "-o", "-l\(id)", "\(dir)/\(name).png"]
        try? task.run()
        task.waitUntilExit()
    }
}
