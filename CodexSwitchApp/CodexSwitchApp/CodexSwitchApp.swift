import SwiftUI

@main
struct CodexSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var viewModel = ProxyViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(viewModel)
                .background(WindowAccessor { window in
                    appDelegate.registerMainWindow(window)
                })
        }
        .windowResizability(.contentSize)
    }
}

private struct WindowAccessor: NSViewRepresentable {
    var onResolve: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window {
                onResolve(window)
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            if let window = nsView.window {
                onResolve(window)
            }
        }
    }
}
