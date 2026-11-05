import AppKit
import UserNotifications

/// Debounce logic for "server is down" notifications. Pure so it is easy to reason about.
struct DownMonitor: Sendable {
	enum Event: Sendable { case down, recovered }
	enum Suppression: Sendable { case none, restart, stop }

	/// Failed polls (10 s apart) before a down notification goes out (~20 s).
	static let threshold = 2
	/// A menu-started restart is forgiven for this many failed polls (~60 s), then it counts.
	static let restartGrace = 6

	private(set) var failures = 0
	private(set) var notified = false
	private(set) var suppression = Suppression.none

	/// Call for an intentional Stop (until the server is healthy again) or Restart.
	mutating func suppress(_ kind: Suppression) { suppression = kind }

	mutating func observe(healthy: Bool) -> Event? {
		if healthy {
			failures = 0
			suppression = .none
			if notified {
				notified = false
				return .recovered
			}
			return nil
		}
		failures += 1
		if suppression == .restart && failures >= DownMonitor.restartGrace { suppression = .none }
		if failures >= DownMonitor.threshold && !notified && suppression == .none {
			notified = true
			return .down
		}
		return nil
	}

	var summary: String {
		"consecutiveFailures=\(failures) notified=\(notified) suppression=\(suppression)"
	}
}

/// Posts notifications through UserNotifications, falling back to osascript if that fails.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
	static let shared = Notifier()
	private var center: UNUserNotificationCenter? {
		Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
	}

	/// Ask once (alert + sound) and become the delegate so clicks and foreground delivery work.
	func prepare() async {
		guard let center else { return }
		center.delegate = self
		if !UserDefaults.standard.bool(forKey: "notificationAuthAsked") {
			UserDefaults.standard.set(true, forKey: "notificationAuthAsked")
			_ = try? await center.requestAuthorization(options: [.alert, .sound])
		}
	}

	/// Returns which path delivered it: "UserNotifications" or "osascript".
	@discardableResult
	func post(title: String, body: String) async -> String {
		if let center {
			let settings = await center.notificationSettings()
			if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
				let c = UNMutableNotificationContent()
				c.title = title
				c.body = body
				c.sound = .default
				let req = UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)
				if (try? await center.add(req)) != nil { return "UserNotifications" }
			}
		}
		let esc = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
		_ = await Backend.run(
			"/usr/bin/osascript", ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""])
		return "osascript"
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
	) async {
		await MainActor.run { _ = NSWorkspace.shared.open(URL(fileURLWithPath: logDir)) }
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .sound]
	}
}
