import AppKit
import Observation
import OSLog
import SwiftUI

@MainActor
@Observable
final class TalkOverlayController {
    static let shared = TalkOverlayController()
    static let overlaySize: CGFloat = 440
    static let orbSize: CGFloat = 96
    static let orbPadding: CGFloat = 12

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.overlay")

    struct Model {
        var isVisible: Bool = false
        var phase: TalkModePhase = .idle
        var isPaused: Bool = false
        var level: Double = 0
    }

    var model = Model()
    /// Readable so a test can assert the panel's real alpha and ordering after an interrupted
    /// dismissal. Only this file assigns it.
    private(set) var window: NSPanel?
    private var hostingView: NSHostingView<TalkOverlayView>?
    private let screenInset: CGFloat = 0
    /// Identifies the desired visibility currently being animated towards. Rotating it on every
    /// present and dismiss lets a completion tell whether it still owns the panel.
    @ObservationIgnored private var transitionID = UUID()

    /// What a finished dismissal animation should do, given the transition it started for.
    enum DismissalOutcome: Equatable {
        /// Still the newest intent, so the panel goes away.
        case hide
        /// A newer present replaced it mid-fade and now owns the panel.
        case superseded
    }

    static func evaluateDismissal(current: UUID, dismissal: UUID) -> DismissalOutcome {
        current == dismissal ? .hide : .superseded
    }

    func present() {
        self.ensureWindow()
        self.transitionID = UUID()
        self.hostingView?.rootView = TalkOverlayView(controller: self)
        let target = self.targetFrame()
        let isFirst = !self.model.isVisible
        if isFirst { self.model.isVisible = true }
        OverlayPanelFactory.present(
            window: self.window,
            isFirstPresent: isFirst,
            target: target)
        { window in
            // A dismissal that this present superseded may have faded the panel partway out,
            // and this path does not animate it back in the way a first present does.
            window.alphaValue = 1
            window.setFrame(target, display: true)
            window.orderFrontRegardless()
        }
    }

    func dismiss() {
        guard let window else {
            self.model.isVisible = false
            return
        }

        // Give up visibility now rather than when the fade ends, so a present arriving during
        // the animation takes the first-present path and animates the panel back in itself.
        self.model.isVisible = false
        let dismissalID = UUID()
        self.transitionID = dismissalID

        OverlayPanelFactory.animateDismiss(window: window) { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                guard Self.evaluateDismissal(
                    current: self.transitionID,
                    dismissal: dismissalID) == .hide
                else {
                    // A newer present owns the panel. Hiding it here is what left Talk enabled
                    // with nothing on screen.
                    return
                }
                window.orderOut(nil)
            }
        }
    }

    func updatePhase(_ phase: TalkModePhase) {
        guard self.model.phase != phase else { return }
        self.logger.info("talk overlay phase=\(phase.rawValue, privacy: .public)")
        self.model.phase = phase
    }

    func updatePaused(_ paused: Bool) {
        guard self.model.isPaused != paused else { return }
        self.logger.info("talk overlay paused=\(paused)")
        self.model.isPaused = paused
    }

    func updateLevel(_ level: Double) {
        guard self.model.isVisible else { return }
        self.model.level = max(0, min(1, level))
    }

    // MARK: - Private

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = OverlayPanelFactory.makePanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.overlaySize, height: Self.overlaySize),
            level: NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue - 4),
            hasShadow: false,
            acceptsMouseMovedEvents: true)

        let host = TalkOverlayHostingView(rootView: TalkOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        let screen = self.window?.screen
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return .zero }
        let size = NSSize(width: Self.overlaySize, height: Self.overlaySize)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width - self.screenInset,
            y: visible.maxY - size.height - self.screenInset)
        return NSRect(origin: origin, size: size)
    }
}

private final class TalkOverlayHostingView: NSHostingView<TalkOverlayView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}
