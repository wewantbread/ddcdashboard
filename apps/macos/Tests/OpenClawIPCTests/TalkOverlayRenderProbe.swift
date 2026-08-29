import AppKit
import Foundation
import Testing
@testable import OpenClaw

/// Writes what the operator would see after the reported sequence, by rendering the real
/// overlay view and compositing it at the panel's actual alpha over a neutral backdrop.
/// Set OPENCLAW_TALK_PROBE_DIR to enable.
@Suite(.serialized)
@MainActor
struct TalkOverlayRenderProbe {
    @Test func `capture the overlay after an interrupted dismissal`() async {
        guard let dir = ProcessInfo.processInfo.environment["OPENCLAW_TALK_PROBE_DIR"] else {
            return
        }

        let controller = TalkOverlayController()
        controller.present()
        controller.updatePhase(.listening)
        controller.updateLevel(0.6)
        try? await Task.sleep(nanoseconds: 400_000_000)
        Self.write(controller, to: dir, name: "1-presented")

        controller.dismiss()
        controller.present()
        try? await Task.sleep(nanoseconds: 500_000_000)
        Self.write(controller, to: dir, name: "2-after-interrupted-dismissal")
    }

    static func write(_ controller: TalkOverlayController, to dir: String, name: String) {
        guard let panel = controller.window, let view = panel.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)

        let size = view.bounds.size
        let composited = NSImage(size: size)
        composited.lockFocus()
        NSColor(calibratedWhite: 0.11, alpha: 1).setFill()
        NSRect(origin: .zero, size: size).fill()
        // What reaches the screen is the view drawn at the window's alpha, and nothing at all
        // when the panel is ordered out.
        if panel.isVisible {
            rep.draw(
                in: NSRect(origin: .zero, size: size),
                from: .zero,
                operation: .sourceOver,
                fraction: panel.alphaValue,
                respectFlipped: true,
                hints: nil)
        }
        composited.unlockFocus()

        guard let tiff = composited.tiffRepresentation,
              let out = NSBitmapImageRep(data: tiff),
              let png = out.representation(using: .png, properties: [:])
        else { return }
        try? png.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        print("PROBE \(name): visible=\(panel.isVisible) alpha=\(panel.alphaValue)")
    }
}
