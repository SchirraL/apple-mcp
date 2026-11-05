import Foundation

// Everything that touches the outside world: launchctl, the HTTP service, files.
// All entry points are @concurrent so they never run on the main actor, and every
// blocking call has a timeout.

let serviceLabel = "io.schirra.apple-mcp"
let servicePortNumber = 47823
let home = FileManager.default.homeDirectoryForCurrentUser.path
let tokenPath = "\(home)/Library/Application Support/apple-mcp/token"
let logDir = "\(home)/Library/Logs/apple-mcp"
let auditPath = "\(logDir)/audit.jsonl"
let plistPath = "\(home)/Library/LaunchAgents/\(serviceLabel).plist"
let domain = "gui/\(getuid())"

struct Health: Sendable {
	var version: String
	var tools: Int
	var apps: Int
}

struct Check: Sendable, Identifiable {
	var id: String
	var label: String
	var status: String
	var detail: String
}

struct Launchd: Sendable {
	var loaded: Bool
	var state: String?
	var pid: Int?
	var lastExit: String?
}

struct Activity: Sendable {
	var tool: String
	var mode: String
	var outcome: String
	var date: Date?
}

enum Backend {
	/// Run a command with a timeout. Output is stdout+stderr; status is -1 on launch failure
	/// and -2 on timeout.
	@concurrent
	static func run(_ exe: String, _ args: [String], timeout: TimeInterval = 5) async
		-> (status: Int32, out: String)
	{
		let p = Process()
		p.executableURL = URL(fileURLWithPath: exe)
		p.arguments = args
		let pipe = Pipe()
		p.standardOutput = pipe
		p.standardError = pipe
		do { try p.run() } catch { return (-1, "\(error.localizedDescription)") }
		let timedOut = LockedFlag()
		let kill = DispatchWorkItem {
			timedOut.set()
			p.terminate()
		}
		DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: kill)
		let data = pipe.fileHandleForReading.readDataToEndOfFile()
		p.waitUntilExit()
		kill.cancel()
		let out = String(decoding: data, as: UTF8.self)
		return (timedOut.value ? -2 : p.terminationStatus, out)
	}

	@concurrent
	static func launchd() async -> Launchd {
		let r = await run("/bin/launchctl", ["print", "\(domain)/\(serviceLabel)"])
		guard r.status == 0 else { return Launchd(loaded: false, state: nil, pid: nil, lastExit: nil) }
		return Launchd(
			loaded: true, state: field("state", in: r.out), pid: field("pid", in: r.out).flatMap { Int($0) },
			lastExit: field("last exit code", in: r.out))
	}

	/// First top-level-ish "key = value" line, e.g. "state = running".
	static func field(_ key: String, in text: String) -> String? {
		for line in text.split(separator: "\n") {
			let t = line.trimmingCharacters(in: .whitespaces)
			if t.hasPrefix("\(key) = ") { return String(t.dropFirst(key.count + 3)) }
		}
		return nil
	}

	@concurrent
	static func health() async -> Health? {
		guard let url = URL(string: "http://127.0.0.1:\(servicePortNumber)/health") else { return nil }
		var req = URLRequest(url: url)
		req.timeoutInterval = 5
		guard let (data, resp) = try? await URLSession.shared.data(for: req),
			(resp as? HTTPURLResponse)?.statusCode == 200,
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			json["ok"] as? Bool == true
		else { return nil }
		return Health(
			version: json["version"] as? String ?? "?", tools: json["tools"] as? Int ?? 0,
			apps: (json["apps"] as? [Any])?.count ?? 0)
	}

	/// Call apple_mcp_doctor through the service. Returns checks or a short error string.
	/// The token is read here, used for one request and never logged.
	@concurrent
	static func doctor() async -> Result<[Check], DoctorError> {
		guard let raw = try? String(contentsOfFile: tokenPath, encoding: .utf8) else {
			return .failure(DoctorError("token file unreadable"))
		}
		let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let url = URL(string: "http://127.0.0.1:\(servicePortNumber)/mcp") else {
			return .failure(DoctorError("bad url"))
		}
		var req = URLRequest(url: url)
		req.httpMethod = "POST"
		req.timeoutInterval = 15
		req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
		req.httpBody = Data(
			#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"apple_mcp_doctor","arguments":{}}}"#
				.utf8)
		guard let (data, resp) = try? await URLSession.shared.data(for: req) else {
			return .failure(DoctorError("service unreachable"))
		}
		let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
		if code == 401 || code == 403 { return .failure(DoctorError("token rejected (HTTP \(code))")) }
		guard code == 200 else { return .failure(DoctorError("HTTP \(code)")) }
		return parseDoctor(String(decoding: data, as: UTF8.self))
	}

	/// The tool returns "<summary>\n\n<json report>" as text, inside a JSON-RPC envelope
	/// (plain JSON or a single SSE "data:" line).
	static func parseDoctor(_ body: String) -> Result<[Check], DoctorError> {
		var payload = body
		if !body.trimmingCharacters(in: .whitespaces).hasPrefix("{") {
			payload = body.split(separator: "\n").first { $0.hasPrefix("data:") }
				.map { String($0.dropFirst(5)) } ?? ""
		}
		guard let env = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
			let result = env["result"] as? [String: Any],
			let content = result["content"] as? [[String: Any]],
			let text = content.first?["text"] as? String
		else { return .failure(DoctorError("unexpected response")) }
		if result["isError"] as? Bool == true { return .failure(DoctorError("doctor failed")) }
		guard let brace = text.range(of: "\n\n{"),
			let report = try? JSONSerialization.jsonObject(
				with: Data(text[text.index(after: brace.lowerBound)...].utf8)) as? [String: Any],
			let checks = report["checks"] as? [[String: Any]]
		else { return .failure(DoctorError("unexpected report")) }
		return .success(
			checks.compactMap { c in
				guard let id = c["id"] as? String, let status = c["status"] as? String else { return nil }
				return Check(
					id: id, label: c["label"] as? String ?? id, status: status,
					detail: c["detail"] as? String ?? "")
			})
	}

	/// Last `count` audit entries, newest first. Only tool/mode/outcome/time are read.
	@concurrent
	static func activity(count: Int = 5) async -> [Activity] {
		guard let fh = FileHandle(forReadingAtPath: auditPath) else { return [] }
		defer { try? fh.close() }
		let size = (try? fh.seekToEnd()) ?? 0
		try? fh.seek(toOffset: size > 65536 ? size - 65536 : 0)
		let text = String(decoding: (try? fh.readToEnd()) ?? Data(), as: UTF8.self)
		let iso = ISO8601DateFormatter()
		iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		var out: [Activity] = []
		for line in text.split(separator: "\n").reversed() {
			guard let j = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
				let tool = j["tool"] as? String
			else { continue }
			out.append(
				Activity(
					tool: tool, mode: j["mode"] as? String ?? "?", outcome: j["outcome"] as? String ?? "?",
					date: (j["ts"] as? String).flatMap { iso.date(from: $0) }))
			if out.count == count { break }
		}
		return out
	}

	// MARK: actions

	@concurrent
	static func restart() async -> String? {
		let r = await run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(serviceLabel)"])
		return r.status == 0 ? nil : "Restart failed: \(r.out.prefix(200))"
	}

	@concurrent
	static func stop() async -> String? {
		let r = await run("/bin/launchctl", ["bootout", "\(domain)/\(serviceLabel)"])
		return r.status == 0 ? nil : "Stop failed: \(r.out.prefix(200))"
	}

	/// bootstrap right after bootout can fail with "Bootstrap failed: 5": wait until the
	/// label is gone, then retry up to 3 times.
	@concurrent
	static func start() async -> String? {
		var last = ""
		for _ in 0..<3 {
			for _ in 0..<10 {
				if await run("/bin/launchctl", ["print", "\(domain)/\(serviceLabel)"]).status != 0 { break }
				try? await Task.sleep(for: .milliseconds(500))
			}
			let r = await run("/bin/launchctl", ["bootstrap", domain, plistPath])
			if r.status == 0 { return nil }
			last = String(r.out.prefix(200))
			try? await Task.sleep(for: .seconds(1))
		}
		return "Start failed: \(last)"
	}
}

struct DoctorError: Error, Sendable {
	var message: String
	init(_ m: String) { message = m }
}

final class LockedFlag: @unchecked Sendable {
	private let lock = NSLock()
	private var flag = false
	func set() { lock.lock(); flag = true; lock.unlock() }
	var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}
