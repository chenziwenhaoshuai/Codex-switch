import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem?
    private weak var mainWindow: NSWindow?
    private var isQuitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
    }

    func applicationWillTerminate(_ notification: Notification) {
        ProxyProcessManager.shared.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isQuitting = true
        return .terminateNow
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return false
    }

    func registerMainWindow(_ window: NSWindow) {
        if mainWindow === window {
            return
        }

        mainWindow = window
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.title = "Codex Switch"

        if let miniaturizeButton = window.standardWindowButton(.miniaturizeButton) {
            miniaturizeButton.target = self
            miniaturizeButton.action = #selector(minimizeToMenuBar(_:))
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isQuitting {
            return true
        }

        hideMainWindow()
        return false
    }

    func windowDidMiniaturize(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === mainWindow else {
            return
        }

        window.deminiaturize(nil)
        hideMainWindow()
    }

    private func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item

        guard let button = item.button else {
            return
        }

        button.image = statusBarImage()
        button.imagePosition = .imageOnly
        button.toolTip = "Codex Switch"
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    private func statusBarImage() -> NSImage {
        let image: NSImage
        if
            let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
            let bundleIcon = NSImage(contentsOf: iconURL)
        {
            image = bundleIcon
        } else {
            image = NSApp.applicationIconImage
        }

        let statusImage = image.copy() as? NSImage ?? image
        statusImage.size = NSSize(width: 18, height: 18)
        statusImage.isTemplate = false
        return statusImage
    }

    private func makeStatusMenu() -> NSMenu {
        let menu = NSMenu()
        let isVisible = mainWindow?.isVisible == true && mainWindow?.isMiniaturized == false

        menu.addItem(NSMenuItem(
            title: isVisible ? "Hide Codex Switch" : "Show Codex Switch",
            action: isVisible ? #selector(hideFromMenu(_:)) : #selector(showFromMenu(_:)),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Quit Codex Switch",
            action: #selector(quitFromMenu(_:)),
            keyEquivalent: "q"
        ))

        for item in menu.items {
            item.target = self
        }

        return menu
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            guard let button = statusItem?.button else {
                return
            }

            statusItem?.menu = makeStatusMenu()
            button.performClick(nil)
            statusItem?.menu = nil
            return
        }

        showMainWindow()
    }

    @objc private func showFromMenu(_ sender: Any?) {
        showMainWindow()
    }

    @objc private func hideFromMenu(_ sender: Any?) {
        hideMainWindow()
    }

    @objc private func quitFromMenu(_ sender: Any?) {
        isQuitting = true
        NSApp.terminate(nil)
    }

    @objc private func minimizeToMenuBar(_ sender: Any?) {
        hideMainWindow()
    }

    private func showMainWindow() {
        guard let window = mainWindow else {
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        if window.isMiniaturized {
            window.deminiaturize(nil)
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func hideMainWindow() {
        mainWindow?.orderOut(nil)
    }
}
