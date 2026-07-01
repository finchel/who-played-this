# Progress Log

## 2026-07-02 — Fable tune-up session (branch `fable/tune-up-2026-07-02`)

### Completed (6 commits, all verified, NOT pushed/merged)
- `b4e0a94` + `d6a145c` — **Server crash DoS fixed.** Any client could kill the whole
  process (and every in-memory game) with one malformed socket emit (e.g. `create-room`
  with a number → `name.trim is not a function` → uncaughtException → exit 1). All
  handlers now type-validate payloads and normalize acks; non-numeric confidence no
  longer stores NaN into scores. Proven by a 72-check fuzz run + regression test.
- `11d1d67` — **Phase guards on host actions.** Double-tapping "Next Song" skipped a
  song (index 0→2, repro'd); double-tap "Everyone's In" reshuffled and wiped votes;
  `start-round` mid-game wiped the round. Each handler now requires its legitimate
  source phase. `back-to-lobby` intentionally left unguarded as host abort hatch.
- `67d818c` — **Zombie-socket kick fixed.** A reconnected player (rejoin on new socket)
  was silently removed 60s later when the server belatedly noticed the old socket died.
  Disconnect handler now skips when a newer socket owns the slot; timer re-checks
  liveness. Grace period is `DISCONNECT_GRACE_MS` env-overridable (default 60s).
- `8ba7590` — **Stale vote selection fixed (client).** Non-host players kept the
  previous song's pick pre-selected with Lock In enabled; one stray tap locked a wrong
  guess at stale confidence. Selection resets when (roundNumber, currentIndex) changes.
- `6d13cbc` — **First test suite.** `npm test` → 4 e2e tests (~1.6s): full 3-player game
  with exact scoring assertions (incl. stealth bonus + auto-reveal), join validation,
  lobby state, malformed-payload resilience. socket.io-client added as devDependency.

### Baseline before vs. after
- Before: zero tests; malformed emit killed server; double-tap skipped songs; reconnect
  race kicked players. After: `npm test` 4/4 green; all three repros pass.

### Remaining / blocked
- Nothing blocked. Unfixed findings ranked in `./context/fable-backlog.md`.
- Branch awaits human review + merge + Cloud Run redeploy (see memory: max-instances=1).
