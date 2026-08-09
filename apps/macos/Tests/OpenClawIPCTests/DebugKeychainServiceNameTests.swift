import Testing
@testable import OpenClaw

struct DebugKeychainServiceNameTests {
    @Test func `debug Keychain services are isolated by bundle identity`() {
        let profileService = "ai.openclaw.gateway-profiles.debug"
        let bindingService = "ai.openclaw.onboarding-route-binding.debug"

        #expect(DebugKeychainServiceName.scoped(
            profileService,
            bundleIdentifier: "ai.openclaw.mac.debug") ==
            "ai.openclaw.gateway-profiles.debug.ai.openclaw.mac.debug")
        #expect(DebugKeychainServiceName.scoped(
            profileService,
            bundleIdentifier: "ai.openclaw.mac.debug.mismatch") ==
            "ai.openclaw.gateway-profiles.debug.ai.openclaw.mac.debug.mismatch")
        #expect(DebugKeychainServiceName.scoped(
            bindingService,
            bundleIdentifier: "ai.openclaw.mac.debug") ==
            "ai.openclaw.onboarding-route-binding.debug.ai.openclaw.mac.debug")
        #expect(DebugKeychainServiceName.scoped(
            bindingService,
            bundleIdentifier: "ai.openclaw.mac.debug.mismatch") ==
            "ai.openclaw.onboarding-route-binding.debug.ai.openclaw.mac.debug.mismatch")
    }

    @Test func `unbundled debug Keychain service has a stable namespace`() {
        let service = "ai.openclaw.gateway-profiles.debug"

        #expect(DebugKeychainServiceName.scoped(service, bundleIdentifier: nil) ==
            "ai.openclaw.gateway-profiles.debug.unbundled")
        #expect(DebugKeychainServiceName.scoped(service, bundleIdentifier: "") ==
            "ai.openclaw.gateway-profiles.debug.unbundled")
    }
}
