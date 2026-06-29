import Foundation

struct ProxyConfig {
    var host: String
    var port: Int
    var routerConfigPath: String
    var logEnabled: Bool
}

class ProxyProcessManager {
    static let shared = ProxyProcessManager()

    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?

    var onOutput: ((String) -> Void)?
    var onTermination: ((Int32) -> Void)?

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    func start(config: ProxyConfig) throws {
        guard process == nil || !process!.isRunning else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")

        guard let scriptPath = Bundle.main.path(forResource: "proxy", ofType: "py") else {
            throw NSError(domain: "CodexSwitch", code: 1,
                         userInfo: [NSLocalizedDescriptionKey: "proxy.py not found in bundle"])
        }

        proc.arguments = ["-u", scriptPath]

        let logDir = Self.logsDirectory()
        proc.environment = [
            "HOST": config.host,
            "PORT": String(config.port),
            "LOG_DIR": logDir.path,
            "ROUTER_CONFIG_PATH": config.routerConfigPath,
            "LOG_ENABLED": config.logEnabled ? "1" : "0",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"
        ]

        proc.currentDirectoryURL = logDir

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.onOutput?(text) }
        }

        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.onOutput?(text) }
        }

        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.onTermination?(p.terminationStatus) }
        }

        try proc.run()
        self.process = proc
        self.outputPipe = outPipe
        self.errorPipe = errPipe
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        proc.interrupt()
        proc.waitUntilExit()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        outputPipe = nil
        errorPipe = nil
    }

    static func logsDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let logDir = appSupport.appendingPathComponent("Codex Switch/logs")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        return logDir
    }

    static func clearLogsDirectory() throws {
        let logDir = logsDirectory()
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: logDir.path) {
            try fileManager.removeItem(at: logDir)
        }
        try fileManager.createDirectory(at: logDir, withIntermediateDirectories: true)
    }
}
