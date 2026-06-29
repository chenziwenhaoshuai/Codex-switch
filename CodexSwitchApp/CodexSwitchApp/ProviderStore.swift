import Foundation

struct ProviderConfig: Identifiable, Codable, Equatable {
    var id: String
    var name: String
    var baseURL: String
    var apiKey: String
    var enabled: Bool
    var headers: [String: String]
    var defaultModel: String
    var modelMapping: ModelMappingConfig
    var chatCompletionsBridgeEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case baseURL
        case apiKey
        case apiKeyEnv
        case authType
        case authHeader
        case authPrefix
        case enabled
        case headers
        case defaultModel
        case modelMapping
        case chatCompletionsBridgeEnabled
    }

    init(
        id: String,
        name: String,
        baseURL: String,
        apiKey: String,
        enabled: Bool,
        headers: [String: String],
        defaultModel: String,
        modelMapping: ModelMappingConfig,
        chatCompletionsBridgeEnabled: Bool
    ) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.enabled = enabled
        self.headers = headers
        self.defaultModel = defaultModel
        self.modelMapping = modelMapping
        self.chatCompletionsBridgeEnabled = chatCompletionsBridgeEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        baseURL = try container.decode(String.self, forKey: .baseURL)
        apiKey = try container.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        headers = try container.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
        defaultModel = try container.decodeIfPresent(String.self, forKey: .defaultModel) ?? ""
        modelMapping = try container.decodeIfPresent(ModelMappingConfig.self, forKey: .modelMapping) ?? .disabled()
        chatCompletionsBridgeEnabled = try container.decodeIfPresent(Bool.self, forKey: .chatCompletionsBridgeEnabled) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(baseURL, forKey: .baseURL)
        try container.encode(apiKey, forKey: .apiKey)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(headers, forKey: .headers)
        try container.encode(defaultModel, forKey: .defaultModel)
        try container.encode(modelMapping, forKey: .modelMapping)
        try container.encode(chatCompletionsBridgeEnabled, forKey: .chatCompletionsBridgeEnabled)
    }

    static func blank() -> ProviderConfig {
        ProviderConfig(
            id: UUID().uuidString,
            name: "New Provider",
            baseURL: "https://api.openai.com/v1",
            apiKey: "",
            enabled: true,
            headers: [:],
            defaultModel: "",
            modelMapping: .disabled(),
            chatCompletionsBridgeEnabled: false
        )
    }

    static func openAI() -> ProviderConfig {
        ProviderConfig(
            id: "openai",
            name: "OpenAI",
            baseURL: "https://api.openai.com/v1",
            apiKey: "",
            enabled: true,
            headers: [:],
            defaultModel: "",
            modelMapping: .disabled(),
            chatCompletionsBridgeEnabled: false
        )
    }
}

struct RouterConfig: Codable {
    var activeProviderId: String
    var providers: [ProviderConfig]

    init(activeProviderId: String, providers: [ProviderConfig]) {
        self.activeProviderId = activeProviderId
        self.providers = providers
    }

    enum CodingKeys: String, CodingKey {
        case activeProviderId
        case providers
        case legacyModelMapping = "modelMapping"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        activeProviderId = try container.decode(String.self, forKey: .activeProviderId)
        providers = try container.decode([ProviderConfig].self, forKey: .providers)
        if let legacyMapping = try container.decodeIfPresent(ModelMappingConfig.self, forKey: .legacyModelMapping),
           legacyMapping.enabled {
            providers = providers.map { provider in
                var migrated = provider
                if !migrated.modelMapping.enabled {
                    migrated.modelMapping = legacyMapping
                }
                return migrated
            }
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(activeProviderId, forKey: .activeProviderId)
        try container.encode(providers, forKey: .providers)
    }
}

struct ModelMappingConfig: Codable, Equatable {
    var enabled: Bool
    var targetModel: String

    static func disabled() -> ModelMappingConfig {
        ModelMappingConfig(enabled: false, targetModel: "")
    }
}

enum ProviderStore {
    static func configDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let configDir = appSupport.appendingPathComponent("Codex Switch")
        try? FileManager.default.createDirectory(at: configDir, withIntermediateDirectories: true)
        return configDir
    }

    static func configURL() -> URL {
        configDirectory().appendingPathComponent("providers.json")
    }

    static func defaultConfig() -> RouterConfig {
        RouterConfig(activeProviderId: "openai", providers: [.openAI()])
    }

    static func load() -> RouterConfig {
        let url = configURL()
        guard let data = try? Data(contentsOf: url) else {
            let config = defaultConfig()
            save(config)
            return config
        }

        do {
            let config = try JSONDecoder().decode(RouterConfig.self, from: data)
            if config.providers.isEmpty {
                let fallback = defaultConfig()
                save(fallback)
                return fallback
            }
            return config
        } catch {
            let fallback = defaultConfig()
            save(fallback)
            return fallback
        }
    }

    static func save(_ config: RouterConfig) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(config) else { return }
        try? data.write(to: configURL(), options: [.atomic])
    }
}
