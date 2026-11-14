// The native window of MAVLink Hub for Mac: shows the hub's control page in a real window of this app (its own Dock
// icon, name and menu) instead of a Chrome window. The app script starts the hub, then runs this with the hub's port.
// Closing the window or quitting the app stops the hub; if the hub stops (Quit in the page), this closes too.
import Cocoa
import WebKit

final class Host: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
  let port: Int
  var window: NSWindow!
  var web: WKWebView!
  var misses = 0
  var base: String { "http://localhost:\(port)" }
  let relaunchMarker = NSTemporaryDirectory() + "mavlink-hub-relaunch"
  init(port: Int) { self.port = port }

  func applicationDidFinishLaunching(_ n: Notification) {
    buildMenu()
    web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    web.uiDelegate = self
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 840),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "MAVLink Hub"
    window.contentView = web
    window.delegate = self
    window.minSize = NSSize(width: 420, height: 560)
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.load(URLRequest(url: URL(string: base + "/launcher")!))
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.check() }
  }

  func buildMenu() {
    let bar = NSMenu(); let appItem = NSMenuItem(); bar.addItem(appItem)
    let m = NSMenu()
    m.addItem(withTitle: "Hide MAVLink Hub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    m.addItem(.separator())
    m.addItem(withTitle: "Quit MAVLink Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = m
    let editItem = NSMenuItem(); bar.addItem(editItem)
    let e = NSMenu(title: "Edit")
    e.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    e.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = e
    NSApp.mainMenu = bar
  }

  // Is the hub still there? Three misses in a row (about six seconds) and this closes too.
  func check() {
    var req = URLRequest(url: URL(string: base + "/info")!); req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
      DispatchQueue.main.async {
        guard let self = self else { return }
        if (resp as? HTTPURLResponse)?.statusCode == 200 { self.misses = 0 } else { self.misses += 1 }
        // After an update the hub stops on purpose; the marker file says to close at once and reopen the new copy.
        if self.misses >= 3 || (self.misses >= 1 && FileManager.default.fileExists(atPath: relaunchMarker)) { NSApp.terminate(nil) }
      }
    }.resume()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
  func windowWillClose(_ n: Notification) { NSApp.terminate(nil) }

  // Quitting the app stops the hub (macOS would remove it anyway); stop it politely so it can tidy up.
  func applicationWillTerminate(_ n: Notification) {
    var req = URLRequest(url: URL(string: base + "/launcher/stop")!)
    req.httpMethod = "POST"; req.timeoutInterval = 1.5
    req.setValue("1", forHTTPHeaderField: "X-Launcher")
    req.setValue(base, forHTTPHeaderField: "Origin")
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume()
    _ = done.wait(timeout: .now() + 1.5)
    // An update was installed over this app: open the new copy (through Launch Services, so it is independent of this one).
    if let path = try? String(contentsOfFile: relaunchMarker, encoding: .utf8) {
      try? FileManager.default.removeItem(atPath: relaunchMarker)
      Thread.sleep(forTimeInterval: 1.0)
      let open = Process()
      open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      open.arguments = ["-n", path.trimmingCharacters(in: .whitespacesAndNewlines)]
      try? open.run()
    }
  }

  // Only the control page lives in this window; everything else (the dashboard, other sites) opens in the browser.
  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    let local = url.host == "localhost" || url.host == "127.0.0.1"
    if local && url.port == port && (url.path.hasPrefix("/launcher") || url.path.hasPrefix("/assets")) { return decisionHandler(.allow) }
    if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
    if let url = a.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
  }
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }
}

let port = Int(CommandLine.arguments.dropFirst().first ?? "") ?? 8080
let app = NSApplication.shared
let host = Host(port: port)
app.delegate = host
app.setActivationPolicy(.regular)
app.run()
