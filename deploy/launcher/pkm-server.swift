// pattern: Imperative Shell
//
// pkm-server <program> [args...]
//
// The launchd job for the PKM server. Invariant: it spawns the program and
// stays its parent until it exits. It must never exec into it, because macOS
// attributes the child's file-access consent (iCloud Drive) to the job's own
// binary, and this binary's identity is what stays stable across uv, Python
// and app upgrades. Do not rebuild it casually: a new build is a new client
// and the consent prompt returns.

import Darwin
import Dispatch
import Foundation

let forwarded: [Int32] = [SIGTERM, SIGINT, SIGHUP]

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty {
    fail("usage: pkm-server <program> [args...]", 64)
}

// Ignore first, or the default action kills the launcher before the
// dispatch source can forward the signal.
for sig in forwarded { signal(sig, SIG_IGN) }

// The child must not inherit the ignored dispositions or a blocked mask.
var attr = posix_spawnattr_t(bitPattern: 0)
posix_spawnattr_init(&attr)
var defaults = sigset_t()
sigemptyset(&defaults)
for sig in forwarded { sigaddset(&defaults, sig) }
posix_spawnattr_setsigdefault(&attr, &defaults)
var emptyMask = sigset_t()
sigemptyset(&emptyMask)
posix_spawnattr_setsigmask(&attr, &emptyMask)
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

var argv: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
argv.append(nil)

var childPid: pid_t = 0
let spawnError = posix_spawnp(&childPid, args[0], nil, &attr, argv, environ)
if spawnError != 0 {
    fail("pkm-server: cannot run \(args[0]): \(String(cString: strerror(spawnError)))", 127)
}

var sources: [DispatchSourceSignal] = []
for sig in forwarded {
    let source = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global())
    source.setEventHandler { kill(childPid, sig) }
    source.resume()
    sources.append(source)
}

var status: Int32 = 0
while waitpid(childPid, &status, 0) < 0 {
    if errno != EINTR { fail("pkm-server: waitpid: \(String(cString: strerror(errno)))", 126) }
}

let termSignal = status & 0x7f
exit(termSignal == 0 ? (status >> 8) & 0xff : 128 + termSignal)
