import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct SettingsViewSmokeTests {
    @Test func `cron settings renders in hosting view`() {
        let store = CronJobsStore(isPreview: true)
        store.schedulerEnabled = false
        store.jobs = [
            CronJob(
                id: "job-1",
                agentId: "ops",
                name: "Morning Check-in",
                description: "Summary job",
                enabled: true,
                deleteAfterRun: nil,
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: 1_700_000_100_000,
                schedule: .cron(expr: "0 8 * * *", tz: "UTC"),
                sessionTarget: .isolated,
                wakeMode: .nextHeartbeat,
                payload: .agentTurn(
                    message: "Summarize",
                    thinking: "low",
                    timeoutSeconds: 120,
                    deliver: nil,
                    channel: nil,
                    to: nil,
                    bestEffortDeliver: nil),
                delivery: CronDelivery(mode: .announce, channel: "whatsapp", to: "+15551234567", bestEffort: true),
                state: CronJobState(
                    nextRunAtMs: 1_700_000_200_000,
                    runningAtMs: nil,
                    lastRunAtMs: 1_700_000_050_000,
                    lastStatus: "ok",
                    lastError: nil,
                    lastDurationMs: 1200)),
        ]
        store.selectedJobId = "job-1"
        store.runEntries = [
            CronRunLogEntry(
                ts: 1_700_000_050_000,
                jobId: "job-1",
                action: "finished",
                status: "ok",
                error: nil,
                summary: "done",
                runAtMs: 1_700_000_050_000,
                durationMs: 1200,
                nextRunAtMs: 1_700_000_200_000),
        ]

        let view = CronSettings(store: store, channelsStore: ChannelsStore(isPreview: true))
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 700)
        hosting.layoutSubtreeIfNeeded()
        _ = hosting.fittingSize
    }

    @Test func `Gateway settings is visible`() {
        let tabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: false)
            .flatMap(\.tabs)
        #expect(tabs.contains(.gateways))
    }

    @Test func `OpenClaw settings require configured inference`() {
        #expect(!SystemAgentAvailability.shouldShow(configuredModel: nil))
        #expect(!SystemAgentAvailability.shouldShow(configuredModel: "   "))
        #expect(SystemAgentAvailability.shouldShow(configuredModel: "openai/gpt-5.5"))

        let hiddenTabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: false)
            .flatMap(\.tabs)
        let visibleTabs = SettingsTabGroup.defaultGroups(showDebug: false, showSystemAgent: true)
            .flatMap(\.tabs)
        #expect(!hiddenTabs.contains(.systemAgent))
        #expect(visibleTabs.contains(.systemAgent))
        #expect(SettingsRootView.normalizedTab(
            .systemAgent,
            showDebug: false,
            showSystemAgent: false) == .general)
        #expect(SettingsRootView.normalizedTab(
            .systemAgent,
            showDebug: false,
            showSystemAgent: true) == .systemAgent)
        let loadingSelection = SettingsRootView.tabSelection(
            requested: .systemAgent,
            showDebug: false,
            inferenceConfiguration: .loading)
        #expect(loadingSelection.selected == .general)
        #expect(loadingSelection.deferred == .systemAgent)
        let configuredSelection = SettingsRootView.tabSelection(
            requested: loadingSelection.deferred ?? .general,
            showDebug: false,
            inferenceConfiguration: .loaded("openai/gpt-5.5"))
        #expect(configuredSelection.selected == .systemAgent)
        #expect(configuredSelection.deferred == nil)
        let unconfiguredSelection = SettingsRootView.tabSelection(
            requested: .systemAgent,
            showDebug: false,
            inferenceConfiguration: .loaded(nil))
        #expect(unconfiguredSelection.selected == .general)
        #expect(unconfiguredSelection.deferred == nil)
        #expect(SettingsRootView.configurationAfterInferenceRefresh(
            current: .loaded("openai/gpt-5.5"),
            result: .failed) == .loaded("openai/gpt-5.5"))
        #expect(SettingsRootView.configurationAfterInferenceRefresh(
            current: .loaded("openai/gpt-5.5"),
            result: .confirmed(nil)) == .loaded(nil))
    }

    @Test func `settings tab router retires a request only when the admitted notification matches`() {
        // Mounted admits its own notification: clears.
        SettingsTabRouter.request(.connection)
        SettingsTabRouter.clearIfMatching(.connection)
        #expect(SettingsTabRouter.consumePending() == nil)

        // A newer request supersedes an older one before the older notification is
        // admitted; admitting the stale request must preserve the newer one, and
        // admitting the newer request must clear it.
        SettingsTabRouter.request(.connection)
        SettingsTabRouter.request(.about)
        SettingsTabRouter.clearIfMatching(.connection)
        #expect(SettingsTabRouter.consumePending() == .about)

        SettingsTabRouter.request(.about)
        SettingsTabRouter.clearIfMatching(.about)
        #expect(SettingsTabRouter.consumePending() == nil)

        // A request made while unmounted stays consumable on first appearance.
        SettingsTabRouter.request(.connection)
        #expect(SettingsTabRouter.consumePending() == .connection)
    }

    @Test func `mounted settings view retires request when the notification is admitted`() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: SettingsTab.windowWidth, height: SettingsTab.windowHeight),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        let hosting = NSHostingView(rootView: SettingsRootView(state: .preview, updater: DisabledUpdaterController()))
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()

        // Same request-then-notify sequence as AppNavigationActions.openSettings and
        // CLIInstallPrompter.openSettings, but with Settings already mounted. Goes through
        // the real `.onReceive` handler via NotificationCenter instead of calling
        // `clearIfMatching` directly, so it fails if that call is ever removed from the
        // handler: a later ordinary appearance would then wrongly consume this stale request.
        SettingsTabRouter.request(.connection)
        NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: SettingsTab.connection)

        #expect(SettingsTabRouter.consumePending() == nil)
    }

    @Test func `OpenClaw preserves same route and resets for gateway changes`() {
        let stateDir = URL(fileURLWithPath: "/Users/tester/.openclaw")
        let directA = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: stateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gateway.example.com/team-a"),
            sshTarget: "",
            sshRemotePort: 18789)
        let directB = MacChatTranscriptCache.gatewayID(
            mode: .remote,
            localStateDir: stateDir,
            remoteTransport: .direct,
            directURL: URL(string: "wss://gateway.example.com/team-b"),
            sshTarget: "",
            sshRemotePort: 18789)

        #expect(directA != directB)
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .systemAgent,
            previousGatewayID: directA,
            currentGatewayID: directA) == .init(clearsPrevious: false, resetsSystemAgent: false))
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .general,
            previousGatewayID: directA,
            currentGatewayID: directA) == .init(clearsPrevious: true, resetsSystemAgent: false))
        #expect(SettingsRootView.configRefreshPlan(
            selectedTab: .systemAgent,
            previousGatewayID: directA,
            currentGatewayID: directB) == .init(clearsPrevious: true, resetsSystemAgent: true))
    }
}
