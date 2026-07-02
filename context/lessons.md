# Lessons

## 2026-07-02 — Diff review structurally misses unchanged lines; grep the old pattern instead
During the socket-handler hardening pass (raw `callback(...)` → safe `ack(...)`), one call
site in the `rejoin` handler stayed raw because it sat in *unchanged* diff context — the
line-by-line diff review never displayed it, and the 72-check fuzz suite happened not to
cover that exact branch (well-formed payload + unknown player + no ack). A second agent
reading the whole file fresh caught it; it was still a live crash vector.
**Why it matters:** reviewing a multi-site pattern change via its diff can only show sites
that WERE changed, never sites that were missed.
**Rule:** after any N-site pattern migration, grep the file(s) for the OLD pattern and
require zero hits before calling it done (verified here: `callback\(` → 0 matches in
server.js). Independent fresh-eyes file reads complement diff review; they don't duplicate it.

## 2026-07-02 — Windows/Node 24: `node --test <dir>` fails; use a glob
`"test": "node --test test/"` errors with `Cannot find module '...\test'` on Node v24
(Windows) — the bare directory arg is treated as a module path, in both PowerShell and
Git Bash. Working form: `node --test test/**/*.test.js` (Node's built-in glob handling,
no shell expansion needed). Cross-environment gotcha; carries to any project using the
built-in test runner here.

## 2026-07-02 — Socket.IO test harnesses: record state from connection time, don't wait after the fact
A verification harness that registers a `game-state` listener only when it wants to wait
races with events delivered earlier and goes flaky (4 phantom failures traced to this).
Robust pattern: attach one listener at connect that stores latest-state-per-socket, and
implement `wait(predicate)` as "check current state first, then subscribe". Used by
test/e2e.test.js `makeStateWaiter` — reuse that shape for future socket tests.
