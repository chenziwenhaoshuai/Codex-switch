import Foundation
import SwiftUI

class ProxyViewModel: ObservableObject {
    @AppStorage("proxyHost") var host = "127.0.0.1"
    @AppStorage("proxyPort") var portString = "8787"
    @AppStorage("persistentLogsEnabled") var persistentLogsEnabled = false
    @Published var isRunning = false
    @Published var logLines: [String] = []
    @Published var errorMessage: String?
    @Published var providers: [ProviderConfig]
    @Published var activeProviderId: String
    @Published var statusMessage: String?

    private let manager = ProxyProcessManager.shared
    private let maxLogLines = 500

    init() {
        let config = ProviderStore.load()
        providers = config.providers
        activeProviderId = config.activeProviderId

        manager.onOutput = { [weak self] text in
            self?.appendLog(text)
        }
        manager.onTermination = { [weak self] status in
            self?.isRunning = false
            self?.appendLog("[Process exited with code \(status)]")
        }
    }

    func start() {
        guard !isRunning else { return }
        errorMessage = nil

        guard let port = Int(portString), port > 0, port <= 65535 else {
            errorMessage = "Invalid port number"
            return
        }

        guard activeProvider != nil else {
            errorMessage = "Select a provider"
            return
        }

        saveProviders()

        let config = ProxyConfig(
            host: host,
            port: port,
            routerConfigPath: ProviderStore.configURL().path,
            logEnabled: persistentLogsEnabled
        )

        do {
            try manager.start(config: config)
            isRunning = manager.isRunning
            appendLog("[Codex Switch started on http://\(host):\(port)]")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stop() {
        manager.stop()
        isRunning = false
        appendLog("[Codex Switch stopped]")
    }

    func clearLogs() {
        logLines.removeAll()
    }

    var activeProvider: ProviderConfig? {
        providers.first { $0.id == activeProviderId }
    }

    func selectProvider(_ providerId: String) {
        guard providers.contains(where: { $0.id == providerId }) else { return }
        activeProviderId = providerId
        statusMessage = nil
        saveProviders()
        appendLog("[Active provider switched to \(activeProvider?.name ?? providerId)]")
    }

    func addProvider() {
        var provider = ProviderConfig.blank()
        provider.name = uniqueProviderName("New Provider")
        providers.append(provider)
        activeProviderId = provider.id
        saveProviders()
    }

    func duplicateProvider(_ provider: ProviderConfig) {
        var copy = provider
        copy.id = UUID().uuidString
        copy.name = uniqueProviderName("\(provider.name) Copy")
        providers.append(copy)
        activeProviderId = copy.id
        saveProviders()
    }

    func deleteProvider(_ provider: ProviderConfig) {
        guard providers.count > 1 else {
            errorMessage = "Keep at least one provider"
            return
        }

        providers.removeAll { $0.id == provider.id }
        if activeProviderId == provider.id {
            activeProviderId = providers.first?.id ?? ""
        }
        saveProviders()
    }

    func updateProvider(_ provider: ProviderConfig) {
        guard let index = providers.firstIndex(where: { $0.id == provider.id }) else { return }
        var updated = provider
        if updated.modelMapping.enabled {
            updated.modelMapping.targetModel = updated.defaultModel
        }
        providers[index] = updated
        saveProviders()
    }

    func saveProviders() {
        var activeId = activeProviderId
        if !providers.contains(where: { $0.id == activeId }) {
            activeId = providers.first?.id ?? ""
            activeProviderId = activeId
        }
        ProviderStore.save(RouterConfig(activeProviderId: activeId, providers: providers))
    }

    func updateRouterSettings(host: String, port: String) {
        self.host = host
        self.portString = port
        saveProviders()
    }

    func updatePersistentLogsEnabled(_ enabled: Bool) {
        persistentLogsEnabled = enabled
        statusMessage = enabled ? "Persistent logs enabled" : "Persistent logs disabled"
        appendLog("[Persistent logs \(enabled ? "enabled" : "disabled")]")
    }

    func clearLogCache() {
        errorMessage = nil
        do {
            try ProxyProcessManager.clearLogsDirectory()
            clearLogs()
            statusMessage = "Log cache cleared"
            appendLog("[Log cache cleared]")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func configureCodexBaseURL() {
        errorMessage = nil
        let baseURL = "http://\(host):\(portString)/v1"
        do {
            try CodexConfigManager.configure(
                baseURL: baseURL,
                model: activeProvider?.defaultModel
            )
            statusMessage = "Codex custom base_url updated"
            appendLog("[Updated Codex custom base_url: \(baseURL)]")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func appendLog(_ text: String) {
        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        logLines.append(contentsOf: lines)
        if logLines.count > maxLogLines {
            logLines.removeFirst(logLines.count - maxLogLines)
        }
    }

    private func uniqueProviderName(_ base: String) -> String {
        var name = base
        var index = 2
        let existing = Set(providers.map(\.name))
        while existing.contains(name) {
            name = "\(base) \(index)"
            index += 1
        }
        return name
    }
}
