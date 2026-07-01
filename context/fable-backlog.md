# Fable Backlog — findings NOT fixed in the 2026-07-02 tune-up

Ranked by impact-to-risk. Each was found and deliberately deferred to keep diffs focused.

1. **No cap / rate limit on room creation** — `server.js` `create-room` + `generateCode()`.
   A public client can spam create-room; rooms dict grows unbounded, and as the 32^4 code
   space fills, `generateCode()`'s recursion degrades toward infinite. Memory exhaustion on
   the public Cloud Run instance. Approach: reject create-room when `Object.keys(rooms).length`
   exceeds a sane cap (e.g. 200) with a new error key; optionally a per-socket cooldown.

2. **Game can stall in 'guessing' when a non-voter is removed** — `server.js` disconnect
   timer removal path. Auto-reveal is only checked inside `submit-vote`; if the last
   player yet to vote is removed by the grace timer, votes never reach `eligibleVoters`.
   Host's manual Reveal button is the workaround. Approach: after removing a player during
   phase 'guessing', re-run the votes>=eligibleVoters check and call `performReveal`.

3. **`eligibleVoters` miscounts when the current song's submitter left** — `server.js`
   `submit-vote` / `broadcastState`. Count assumes the submitter is among active players;
   if they were removed, reveal fires one vote early (one player's vote never counted).
   Approach: compute eligible voters as active players minus (1 if submitter still active).

4. **Spectators (mid-round joiners) appear as vote options** — `public/index.html`
   `renderGuessing` builds the grid from `s.players` minus self; guessing a spectator is
   always wrong. Approach: server should send active (non-spectator) names for the grid,
   or client filters using a spectator list included in state.

5. **Dead `room-closed` listener / missing "end game" feature** — client handles
   `room-closed` (`index.html` ~line 901) but the server never emits it. Either implement a
   host "end game" action that emits it, or drop the dead handler.

6. **Case-sensitivity mismatch in reconnect paths** — `join-room` grace takeover matches
   names case-insensitively; `rejoin` matches exactly (`server.js` rejoin handler). A user
   whose device re-typed the name with different casing rejoins as a duplicate. Low
   likelihood since rejoin uses server-provided `myName` from sessionStorage.

7. **Socket.IO CORS `origin: '*'`** — `server.js:9`. Any website can drive the socket API
   of the deployed instance. Low severity for a party game (codes are short-lived), but
   tightening to same-origin would cost one line. Note: room codes are guessable (32^4).

8. **Reveal screen omits active players who never voted** — cosmetic; only voters and the
   submitter are listed, so a player removed mid-song or a host force-reveal leaves gaps.

9. **README deploy docs drift** — README lists Railway/Render/Fly/ngrok but not the actual
   Cloud Run deployment (Dockerfile + .gcloudignore exist; memory notes max-instances must
   stay 1 because state is in-memory). Document the real deploy path.
