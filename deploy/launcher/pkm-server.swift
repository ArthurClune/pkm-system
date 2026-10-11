// pattern: Imperative Shell
//
// pkm-server <program> [args...]
//
// The launchd job for the PKM server. Invariant: it spawns the program and
// stays its parent until it exits. It must never exec into it, because macOS
// attributes the child's file-access consent (iCloud Drive) to the job's own
// binary. That consent is keyed to this binary's path and code hash, which
// stay the same across uv, Python and app upgrades. Rebuilding after a source
// or Swift toolchain change gives a new hash and the consent prompt returns.
//
// TERM, INT and HUP are blocked across the spawn and unblocked once the child
// pid is recorded. A signal that arrives in that window stays pending and is
// forwarded at the unblock; ignoring it instead would drop it while the child
// keeps running. One that arrives before the block kills the launcher while
// no child exists yet.

import Darwin
import Foundation

let forwarded: [Int32] = [SIGTERM, SIGINT, SIGHUP]

nonisolated(unsafe) var childPid: pid_t = 0

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty {
    fail("usage: pkm-server <program> [args...]", 64)
}

var forwardedSet = sigset_t()
sigemptyset(&forwardedSet)
for sig in forwarded { sigaddset(&forwardedSet, sig) }
sigprocmask(SIG_BLOCK, &forwardedSet, nil)

for sig in forwarded {
    var action = sigaction()
    action.__sigaction_u.__sa_handler = { received in
        if childPid > 0 { kill(childPid, received) }
    }
    sigemptyset(&action.sa_mask)
    sigaction(sig, &action, nil)
}

// The child must not inherit these handlers' dispositions or a blocked mask.
var attr = posix_spawnattr_t(bitPattern: 0)
posix_spawnattr_init(&attr)
posix_spawnattr_setsigdefault(&attr, &forwardedSet)
var emptyMask = sigset_t()
sigemptyset(&emptyMask)
posix_spawnattr_setsigmask(&attr, &emptyMask)
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))

var argv: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
argv.append(nil)

var pid: pid_t = 0
let spawnError = posix_spawnp(&pid, args[0], nil, &attr, argv, environ)
if spawnError != 0 {
    fail("pkm-server: cannot run \(args[0]): \(String(cString: strerror(spawnError)))", 127)
}
childPid = pid
sigprocmask(SIG_UNBLOCK, &forwardedSet, nil)

var status: Int32 = 0
while waitpid(pid, &status, 0) < 0 {
    if errno != EINTR { fail("pkm-server: waitpid: \(String(cString: strerror(errno)))", 126) }
}

let termSignal = status & 0x7f
exit(termSignal == 0 ? (status >> 8) & 0xff : 128 + termSignal)
