import Foundation

enum CodexConfigManager {
    static let providerId = "custom"

    static func configure(baseURL: String, model: String?) throws {
        let configURL = configFileURL()

        try FileManager.default.createDirectory(
            at: configURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let original = (try? String(contentsOf: configURL, encoding: .utf8)) ?? ""
        var content = original
        if let model, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            content = setTopLevelValue("model", value: model, in: content)
        }
        content = updateCustomProviderBaseURL(baseURL: baseURL, in: content)

        try content.write(to: configURL, atomically: true, encoding: .utf8)
    }

    private static func configFileURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["CODEX_CONFIG_PATH"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }

        return FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".codex/config.toml")
    }

    private static func setTopLevelValue(_ key: String, value: String, in content: String) -> String {
        var lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let escapedValue = escapeTomlString(value)
        let replacement = "\(key) = \"\(escapedValue)\""

        for index in lines.indices {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") {
                break
            }
            if trimmed.hasPrefix("\(key) ") || trimmed.hasPrefix("\(key)=") {
                lines[index] = replacement
                return lines.joined(separator: "\n")
            }
        }

        lines.insert(replacement, at: 0)
        return lines.joined(separator: "\n")
    }

    private static func updateCustomProviderBaseURL(baseURL: String, in content: String) -> String {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let header = "[model_providers.\(providerId)]"

        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == header }) else {
            let block = providerBlock(baseURL: baseURL)
            let separator = content.hasSuffix("\n") || content.isEmpty ? "" : "\n"
            return content + separator + "\n" + block
        }

        var end = lines.count
        for index in lines.index(after: start)..<lines.endIndex {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
                end = index
                break
            }
        }

        var updated = lines
        let replacement = "base_url = \"\(escapeTomlString(baseURL))\""
        for index in lines.index(after: start)..<end {
            let trimmed = lines[index].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("base_url ") || trimmed.hasPrefix("base_url=") {
                updated[index] = replacement
                return updated.joined(separator: "\n")
            }
        }

        updated.insert(replacement, at: end)
        return updated.joined(separator: "\n")
    }

    private static func providerBlock(baseURL: String) -> String {
        let escapedBaseURL = escapeTomlString(baseURL)
        return """
        [model_providers.\(providerId)]
        name = "custom"
        wire_api = "responses"
        requires_openai_auth = true
        base_url = "\(escapedBaseURL)"
        """
    }

    private static func escapeTomlString(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}
