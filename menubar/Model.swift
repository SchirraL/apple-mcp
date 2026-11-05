import AppKit
import ServiceManagement
import SwiftUI

@MainActor
final class Model: ObservableObject {
	@Published var health: Health?
	@Published var launchd = Launchd(loaded: false, state: nil, pid: nil, lastExit: nil)
	@Published var checks: [Check] = []
	@Published var doctorError: String?
	@Published var activity: [Activity] = []
	@Published var busy: String?
	@Published var loginEnabled = SMAppService.mainApp.status == .enabled
	@Published var notifyEnabled = UserDefaults.standard.object(forKey: "notifyOnDown") as? Bool ?? true
	private(set) var monitor = DownMonitor()
	private var lastDoctor = Date.distantPast
	private var tasks: [Task<Void, Never>] = []

	enum Level { case ok, warning, error }

	var level: Level {
		if health == nil { return .error }
		if checks.contains(where: { $0.status == "denied" || $0.status == "not_determined" }) {
			return .warning
		}
		return .ok
	}

	var symbol: String {
		switch level {
		case .ok: return "bolt.horizontal.circle"
		case .warning: return "exclamationmark.triangle"
		case .error: return "bolt.slash.circle"
		}
	}

	func startPolling() {
		tasks.append(Task { while !Task.isCancelled { await refreshFast(); try? await Task.sleep(for: .seconds(10)) } })
		tasks.append(Task { while !Task.isCancelled { await refreshDoctor(force: true); try? await Task.sleep(for: .seconds(300)) } })
	}

	func refreshFast() async {
		async let h = Backend.health()
		async let l = Backend.launchd()
		async let a = Backend.activity()
		(health, launchd, activity) = await (h, l, a)
		handle(monitor.observe(healthy: health != nil))
	}

	func setNotify(_ on: Bool) {
		notifyEnabled = on
		UserDefaults.standard.set(on, forKey: "notifyOnDown")
	}

	private func handle(_ event: DownMonitor.Event?) {
		guard notifyEnabled, let event else { return }
		let exit = launchd.loaded ? launchd.lastExit : nil
		Task {
			switch event {
			case .down:
				let tail = exit.map { " Last exit: \($0)." } ?? (launchd.loaded ? "" : " The service is not loaded.")
				await Notifier.shared.post(
					title: "apple-mcp is down", body: "Claude can't use your Mac's apps.\(tail)")
			case .recovered:
				await Notifier.shared.post(title: "apple-mcp is running again", body: "Apple tools are available.")
			}
		}
	}

	func refreshDoctor(force: Bool = false) async {
		guard force || Date().timeIntervalSince(lastDoctor) > 30 else { return }
		lastDoctor = Date()
		switch await Backend.doctor() {
		case .success(let c): checks = c; doctorError = nil
		case .failure(let e): checks = []; doctorError = e.message
		}
	}

	func refreshAll() async {
		await refreshFast()
		await refreshDoctor(force: true)
	}

	/// Called when the menu opens.
	func menuOpened() {
		Task {
			await refreshFast()
			await refreshDoctor()
		}
	}

	func perform(_ name: String, suppress: DownMonitor.Suppression = .none, _ op: @escaping @Sendable () async -> String?) {
		guard busy == nil else { return }
		busy = name
		if suppress != .none { monitor.suppress(suppress) }
		Task {
			let err = await op()
			try? await Task.sleep(for: .seconds(1.5))
			await refreshAll()
			busy = nil
			if let err { alert(err) }
		}
	}

	func confirmStop() {
		let a = NSAlert()
		a.messageText = "Stop the apple-mcp server?"
		a.informativeText = "Claude and other MCP clients lose their Apple tools until it is started again."
		a.addButton(withTitle: "Stop Server")
		a.addButton(withTitle: "Cancel")
		a.alertStyle = .warning
		NSApp.activate(ignoringOtherApps: true)
		if a.runModal() == .alertFirstButtonReturn { perform("Stopping…", suppress: .stop) { await Backend.stop() } }
	}

	func alert(_ text: String) {
		let a = NSAlert()
		a.messageText = text
		NSApp.activate(ignoringOtherApps: true)
		a.runModal()
	}

	func setLogin(_ on: Bool) {
		do {
			if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
		} catch { alert("Launch at login failed: \(error.localizedDescription)") }
		loginEnabled = SMAppService.mainApp.status == .enabled
	}

	func openPane(_ id: String) {
		let pane: String
		switch id {
		case "calendars": pane = "Privacy_Calendars"
		case "reminders": pane = "Privacy_Reminders"
		case "contacts": pane = "Privacy_Contacts"
		case _ where id.hasPrefix("fda_"): pane = "Privacy_AllFiles"
		case _ where id.hasPrefix("automation_"): pane = "Privacy_Automation"
		default: pane = "Privacy"
		}
		openSettings(pane)
	}

	func openSettings(_ pane: String) {
		if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
			NSWorkspace.shared.open(url)
		}
	}

	// MARK: text model (also used by --dump-state)

	static func glyph(_ status: String) -> String {
		switch status {
		case "ok": return "✓"
		case "denied": return "✗"
		case "not_determined": return "?"
		default: return "–"
		}
	}

	static func isOK(_ status: String) -> Bool { status == "ok" }

	var headerLines: [String] {
		var out: [String] = []
		if let h = health {
			out.append("apple-mcp \(h.version) — running")
			out.append("\(h.tools) tools · \(h.apps) apps")
		} else {
			out.append("apple-mcp — \(launchd.loaded ? "not responding" : "stopped")")
		}
		if launchd.loaded {
			let state = launchd.state ?? "?"
			out.append("launchd: \(state)" + (launchd.pid.map { ", pid \($0)" } ?? ""))
		} else {
			out.append("launchd: not loaded")
		}
		return out
	}

	var permissionLines: [String] {
		if let e = doctorError { return ["Permissions unavailable: \(e)"] }
		return checks.map { "\(Model.glyph($0.status)) \($0.label)" }
	}

	static func relative(_ d: Date?) -> String {
		guard let d else { return "?" }
		let f = RelativeDateTimeFormatter()
		f.unitsStyle = .abbreviated
		return f.localizedString(for: d, relativeTo: Date())
	}

	func activityLine(_ a: Activity) -> String {
		"\(a.tool) · \(a.mode) · \(a.outcome) · \(Model.relative(a.date))"
	}

	func dump() -> String {
		var out = ["status: \(level)", "icon: \(symbol)", "[header]"]
		out += headerLines
		out += ["[permissions]"] + permissionLines.map { $0 }
		out += ["[activity]"] + (activity.isEmpty ? ["(none)"] : activity.map(activityLine))
		out += ["[notify] enabled=\(notifyEnabled) \(monitor.summary)"]
		out += ["[login] \(loginStatusName)"]
		return out.joined(separator: "\n")
	}

	var loginStatusName: String {
		switch SMAppService.mainApp.status {
		case .enabled: return "enabled"
		case .notRegistered: return "notRegistered"
		case .requiresApproval: return "requiresApproval"
		case .notFound: return "notFound"
		@unknown default: return "unknown"
		}
	}
}
