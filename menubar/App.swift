import ServiceManagement
import SwiftUI

@main
struct AppleMCPMenu: App {
	private let model = Model()

	init() {
		let args = CommandLine.arguments
		if args.contains("--dump-state") {
			Task { @MainActor in
				let m = Model()
				await m.refreshAll()
				print(m.dump())
				exit(0)
			}
		} else if !args.contains("--login-probe") {
			model.startPolling()
		}
		if args.contains("--test-notify") {
			Task { @MainActor in
				await Notifier.shared.prepare()
				let path = await Notifier.shared.post(title: "apple-mcp test", body: "Sample notification.")
				print("delivered via \(path)")
				try? await Task.sleep(for: .seconds(2))
				exit(0)
			}
		} else {
			Task { await Notifier.shared.prepare() }
		}
		if args.contains("--login-probe") {
			// Measures whether SMAppService works for this (ad-hoc signed) bundle.
			Task { @MainActor in
				let m = Model()
				var lines = ["before: \(m.loginStatusName)"]
				do { try SMAppService.mainApp.register() } catch { lines.append("register error: \(error)") }
				lines.append("after register: \(m.loginStatusName)")
				try? await SMAppService.mainApp.unregister()
				lines.append("after unregister: \(m.loginStatusName)")
				print(lines.joined(separator: "\n"))
				exit(0)
			}
		}
	}

	var body: some Scene {
		MenuBarExtra {
			MenuContent(model: model)
		} label: {
			MenuLabel(model: model)
		}
		.menuBarExtraStyle(.menu)
	}
}

struct MenuLabel: View {
	@ObservedObject var model: Model
	var body: some View { Image(systemName: model.symbol) }
}

struct MenuContent: View {
	@ObservedObject var model: Model

	var body: some View {
		ForEach(Array(model.headerLines.enumerated()), id: \.offset) { Text($0.element) }
		Divider()
		Text("Permissions")
		if let e = model.doctorError {
			Text("Unavailable: \(e)")
		} else if model.checks.isEmpty {
			Text("Checking…")
		}
		ForEach(model.checks) { c in
			if Model.isOK(c.status) {
				Text("\(Model.glyph(c.status)) \(c.label)")
			} else {
				Button("\(Model.glyph(c.status)) \(c.label) — \(c.status.replacingOccurrences(of: "_", with: " "))") {
					model.openPane(c.id)
				}
			}
		}
		Divider()
		Text("Recent activity")
		if model.activity.isEmpty { Text("None yet") }
		ForEach(Array(model.activity.enumerated()), id: \.offset) { Text(model.activityLine($0.element)) }
		Button("Open audit log") {
			NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: auditPath)])
		}
		Divider()
		if let b = model.busy { Text(b) }
		Button("Restart server") { model.perform("Restarting…", suppress: .restart) { await Backend.restart() } }
			.disabled(!model.launchd.loaded || model.busy != nil)
		if model.launchd.loaded {
			Button("Stop server…") { model.confirmStop() }.disabled(model.busy != nil)
		} else {
			Button("Start server") { model.perform("Starting…") { await Backend.start() } }
				.disabled(model.busy != nil)
		}
		Button("Open logs folder") { NSWorkspace.shared.open(URL(fileURLWithPath: logDir)) }
		Button("Open Privacy & Security settings") { model.openSettings("Privacy") }
		Divider()
		Toggle("Launch at login", isOn: Binding(get: { model.loginEnabled }, set: { model.setLogin($0) }))
		Toggle("Notify when server goes down", isOn: Binding(get: { model.notifyEnabled }, set: { model.setNotify($0) }))
		if model.notifyEnabled && !model.notifyAuthorized {
			Button("Allow notifications…") {
				Task {
					await Notifier.shared.requestOrOpenSettings()
					model.notifyAuthorized = await Notifier.shared.isAuthorized()
				}
			}
		}
		Button("Quit Apple MCP Menu (server keeps running)") { NSApplication.shared.terminate(nil) }
			.keyboardShortcut("q")
	}
}
