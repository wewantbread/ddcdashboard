enum DebugKeychainServiceName {
    static func scoped(_ service: String, bundleIdentifier: String?) -> String {
        // An unbundled debug executable must not share a real app bundle's Keychain ACL.
        guard let bundleIdentifier, !bundleIdentifier.isEmpty else {
            return "\(service).unbundled"
        }
        return "\(service).\(bundleIdentifier)"
    }
}
