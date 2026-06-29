import SwiftUI

struct ContentView: View {
    @EnvironmentObject var viewModel: ProxyViewModel
    @State private var showLogs = false
    @State private var editingProvider: ProviderConfig?
    @State private var showSettings = false

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                toolbar

                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(viewModel.providers) { provider in
                            ProviderCardView(
                                provider: provider,
                                isActive: provider.id == viewModel.activeProviderId,
                                isRunning: viewModel.isRunning,
                                onSelect: {
                                    viewModel.selectProvider(provider.id)
                                },
                                onEnable: {
                                    viewModel.selectProvider(provider.id)
                                },
                                onEdit: {
                                    editingProvider = provider
                                },
                                onDuplicate: {
                                    viewModel.duplicateProvider(provider)
                                },
                                onDelete: {
                                    viewModel.deleteProvider(provider)
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 14)
                }
                .frame(maxHeight: .infinity)

                footer
            }
            .frame(maxHeight: .infinity)

            if showLogs {
                LogPanelView(lines: viewModel.logLines) {
                    viewModel.clearLogs()
                } onClose: {
                    showLogs = false
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 42)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: showLogs)
        .frame(width: 920, height: 646)
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(item: $editingProvider) { provider in
            ProviderEditSheet(provider: provider) { updated in
                viewModel.updateProvider(updated)
                editingProvider = nil
            } onCancel: {
                editingProvider = nil
            }
        }
        .sheet(isPresented: $showSettings) {
            RouterSettingsSheet(
                host: viewModel.host,
                port: viewModel.portString
            ) { host, port in
                viewModel.updateRouterSettings(host: host, port: port)
                showSettings = false
            } onConfigureCodex: { host, port in
                viewModel.updateRouterSettings(host: host, port: port)
                viewModel.configureCodexBaseURL()
            } onCancel: {
                showSettings = false
            }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Text("Codex Switch")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.accentColor)

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(.borderless)
            .help("Settings")

            Button {
                showLogs.toggle()
            } label: {
                Image(systemName: "terminal")
                    .font(.system(size: 13, weight: .medium))
            }
            .buttonStyle(.borderless)
            .help(showLogs ? "Hide logs" : "Show logs")

            Toggle("", isOn: Binding(
                get: { viewModel.isRunning },
                set: { value in
                    value ? viewModel.start() : viewModel.stop()
                }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .controlSize(.small)
            .help(viewModel.isRunning ? "Stop router" : "Start router")

            Spacer()

            Button {
                viewModel.addProvider()
                if let provider = viewModel.activeProvider {
                    editingProvider = provider
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(Color.orange))
            }
            .buttonStyle(.plain)
            .help("Add provider")
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 8)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 10) {
                Circle()
                    .fill(viewModel.isRunning ? Color.green : Color.gray.opacity(0.65))
                    .frame(width: 8, height: 8)

                Text(viewModel.isRunning ? "Running" : "Stopped")
                    .font(.caption)
                    .foregroundColor(.secondary)

                if let provider = viewModel.activeProvider {
                    Text(provider.name)
                        .font(.caption)
                        .foregroundColor(.primary)
                }

                Text("http://\(viewModel.host):\(viewModel.portString)/v1")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)

                Button {
                    copy("http://\(viewModel.host):\(viewModel.portString)/v1")
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 10))
                }
                .buttonStyle(.borderless)
                .help("Copy OPENAI_BASE_URL")

                Spacer()

                if let error = viewModel.errorMessage {
                    Text(error)
                        .font(.caption2)
                        .foregroundColor(.red)
                } else if let status = viewModel.statusMessage {
                    Text(status)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }

                Text("© 2026 Ziwen")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 9)

        }
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

struct RouterSettingsSheet: View {
    @State private var host: String
    @State private var port: String
    var onSave: (String, String) -> Void
    var onConfigureCodex: (String, String) -> Void
    var onCancel: () -> Void

    init(
        host: String,
        port: String,
        onSave: @escaping (String, String) -> Void,
        onConfigureCodex: @escaping (String, String) -> Void,
        onCancel: @escaping () -> Void
    ) {
        _host = State(initialValue: host)
        _port = State(initialValue: port)
        self.onSave = onSave
        self.onConfigureCodex = onConfigureCodex
        self.onCancel = onCancel
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings")
                .font(.system(size: 16, weight: .semibold))

            formRow("Host") {
                TextField("127.0.0.1", text: $host)
            }

            formRow("Port") {
                TextField("8787", text: $port)
            }

            Button {
                onConfigureCodex(host, port)
            } label: {
                Label("Set Codex custom base_url", systemImage: "wand.and.stars")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .help("Update custom base_url in ~/.codex/config.toml")

            HStack {
                Spacer()
                Button("Cancel") {
                    onCancel()
                }
                Button("Save") {
                    onSave(host, port)
                }
                .buttonStyle(.borderedProminent)
            }

            HStack {
                Spacer()
                Text("© 2026 Ziwen")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
        }
        .padding(20)
        .frame(width: 430)
    }

    private func formRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 68, alignment: .trailing)
            content()
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
        }
    }
}

struct ProviderCardView: View {
    let provider: ProviderConfig
    let isActive: Bool
    let isRunning: Bool
    let onSelect: () -> Void
    let onEnable: () -> Void
    let onEdit: () -> Void
    let onDuplicate: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color.gray.opacity(0.55))
                    .frame(width: 18)

                providerAvatar

                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 7) {
                        Text(provider.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.primary)
                            .lineLimit(1)

                        if provider.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            tag("No Key", color: .gray)
                        } else {
                            tag("API Key", color: .blue)
                        }
                    }

                    Text(provider.baseURL)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.accentColor)
                        .lineLimit(1)
                }

                Spacer(minLength: 16)

                rowActions
            }
            .padding(.horizontal, 14)
            .frame(height: 64)
            .background(cardBackground)
            .overlay(cardBorder)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Enable") { onEnable() }
            Button("Edit") { onEdit() }
            Button("Duplicate") { onDuplicate() }
            Divider()
            Button("Delete") { onDelete() }
        }
    }

    private var providerAvatar: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.gray.opacity(0.18), lineWidth: 1)
                )
            Text(initials)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.secondary)
        }
        .frame(width: 30, height: 30)
    }

    private var rowActions: some View {
        HStack(spacing: 12) {
            Button(action: onEnable) {
                Label(isActive ? "Selected" : "Use", systemImage: isActive ? "checkmark" : "play")
                    .font(.system(size: 12, weight: .medium))
                    .labelStyle(.titleAndIcon)
                    .foregroundColor(isActive ? .accentColor : .white)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(isActive ? Color.accentColor.opacity(0.12) : Color.accentColor)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 7)
                            .stroke(isActive ? Color.accentColor.opacity(0.45) : Color.clear, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            iconButton("square.and.pencil", action: onEdit, help: "Edit")
            iconButton("doc.on.doc", action: onDuplicate, help: "Duplicate")
            iconButton("trash", action: onDelete, help: "Delete")
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(isActive ? Color.accentColor.opacity(0.08) : Color(nsColor: .textBackgroundColor))
    }

    private var cardBorder: some View {
        RoundedRectangle(cornerRadius: 10)
            .stroke(isActive ? Color.accentColor.opacity(0.78) : Color.gray.opacity(0.18), lineWidth: isActive ? 1.25 : 1)
    }

    private var initials: String {
        let words = provider.name.split(separator: " ")
        if words.count >= 2 {
            return words.prefix(2).compactMap { $0.first }.map(String.init).joined().uppercased()
        }
        return String(provider.name.prefix(2)).uppercased()
    }

    private func tag(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.12)))
    }

    private func iconButton(_ systemName: String, action: @escaping () -> Void, help: String) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(.secondary)
                .frame(width: 20, height: 28)
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

struct ProviderEditSheet: View {
    @State private var draft: ProviderConfig
    var onSave: (ProviderConfig) -> Void
    var onCancel: () -> Void

    init(provider: ProviderConfig, onSave: @escaping (ProviderConfig) -> Void, onCancel: @escaping () -> Void) {
        _draft = State(initialValue: provider)
        self.onSave = onSave
        self.onCancel = onCancel
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Provider")
                .font(.system(size: 16, weight: .semibold))

            formRow("Name") {
                TextField("OpenAI", text: $draft.name)
            }

            formRow("Base URL") {
                TextField("https://api.openai.com/v1", text: $draft.baseURL)
            }

            formRow("API Key") {
                SecureField("stored in providers.json", text: $draft.apiKey)
            }

            formRow("Default Model") {
                TextField("gpt-5", text: $draft.defaultModel)
            }

            Toggle("统一映射到默认模型", isOn: $draft.modelMapping.enabled)
                .toggleStyle(.checkbox)

            Toggle("开启chat转response接口", isOn: $draft.chatCompletionsBridgeEnabled)
                .toggleStyle(.checkbox)

            Toggle("Enabled", isOn: $draft.enabled)
                .toggleStyle(.checkbox)

            HStack {
                Spacer()
                Button("Cancel") {
                    onCancel()
                }
                Button("Save") {
                    onSave(draft)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 430)
    }

    private func formRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
                .frame(width: 68, alignment: .trailing)
            content()
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
        }
    }
}

struct LogPanelView: View {
    let lines: [String]
    var onClear: () -> Void
    var onClose: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                Text("Logs (\(lines.count))")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Button("Clear") {
                    onClear()
                }
                .font(.caption2)
                .buttonStyle(.borderless)

                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Hide logs")
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { idx, line in
                            Text(line)
                                .font(.system(size: 10, design: .monospaced))
                                .textSelection(.enabled)
                                .id(idx)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                .frame(height: 110)
                .background(Color(nsColor: .textBackgroundColor))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.gray.opacity(0.16), lineWidth: 1)
                )
                .onChange(of: lines.count) { _ in
                    if let last = lines.indices.last {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .windowBackgroundColor))
                .shadow(color: Color.black.opacity(0.16), radius: 12, x: 0, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.gray.opacity(0.18), lineWidth: 1)
        )
    }
}
