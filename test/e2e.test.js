'use strict';

// End-to-end tests for the "Who Played This?" game server.
//
// These tests spawn the real server (server.js) as a child process and drive
// it exclusively through real socket.io-client connections -- no mocking of
// server internals. Everything is synchronized off socket.io acknowledgements
// and 'game-state' broadcasts (never bare sleeps), so the suite is
// deterministic and fast.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT_DIR = path.join(__dirname, '..');
const PORT = 4100 + Math.floor(Math.random() * 400);
const SERVER_URL = `http://localhost:${PORT}`;

let serverProcess = null;

// ─── Server lifecycle ─────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: ROOT_DIR,
      env: { ...process.env, PORT: String(PORT) },
      shell: false
    });

    let settled = false;
    let stdoutBuffer = '';

    const onStdout = (chunk) => {
      stdoutBuffer += chunk.toString();
      if (!settled && stdoutBuffer.includes('Running on')) {
        settled = true;
        clearTimeout(startupTimer);
        child.stdout.off('data', onStdout);
        resolve(child);
      }
    };

    child.stdout.on('data', onStdout);
    // Surface server-side crashes/errors in the test output for diagnosis
    // (this is expected to fire during the malformed-payload test).
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[server stderr] ${chunk}`);
    });

    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        reject(err);
      }
    });

    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        reject(new Error(`server process exited before startup (code=${code}, signal=${signal})`));
      }
    });

    const startupTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('server did not print startup banner in time'));
      }
    }, 10000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const fallback = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(fallback);
      resolve();
    });
    try {
      child.kill();
    } catch {
      clearTimeout(fallback);
      resolve();
    }
  });
}

before(async () => {
  serverProcess = await startServer();
});

after(async () => {
  await stopServer(serverProcess);
});

// ─── Client helpers ───────────────────────────────────────────

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, {
      reconnection: false,
      forceNew: true,
      transports: ['websocket']
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out connecting to test server'));
    }, 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ack on "${event}"`));
    }, timeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// Tracks the latest 'game-state' a socket has received and lets tests await
// the next state matching a predicate, without polling or sleeping.
function makeStateWaiter(socket) {
  let current = null;
  const pending = [];

  socket.on('game-state', (state) => {
    current = state;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].predicate(state)) {
        const [entry] = pending.splice(i, 1);
        entry.resolve(state);
      }
    }
  });

  return {
    get current() {
      return current;
    },
    wait(predicate, timeoutMs = 5000) {
      if (current && predicate(current)) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve: (state) => {
            clearTimeout(entry.timer);
            resolve(state);
          }
        };
        entry.timer = setTimeout(() => {
          const idx = pending.indexOf(entry);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error('timed out waiting for a matching game-state'));
        }, timeoutMs);
        pending.push(entry);
      });
    }
  };
}

// ─── Tests ─────────────────────────────────────────────────────

test('full game happy path with exact scoring', { timeout: 20000 }, async () => {
  const host = await connectClient();
  const alice = await connectClient();
  const bob = await connectClient();

  const hostState = makeStateWaiter(host);
  const aliceState = makeStateWaiter(alice);
  const bobState = makeStateWaiter(bob);

  try {
    const created = await emitAck(host, 'create-room', 'Host');
    assert.ok(created && typeof created.code === 'string', 'create-room should return a code');
    const code = created.code;

    assert.deepEqual(await emitAck(alice, 'join-room', { name: 'Alice', code }), { success: true });
    assert.deepEqual(await emitAck(bob, 'join-room', { name: 'Bob', code }), { success: true });

    await hostState.wait((s) => s.phase === 'lobby' && s.players.length === 3);

    host.emit('start-round');
    await Promise.all([
      hostState.wait((s) => s.phase === 'submitting'),
      aliceState.wait((s) => s.phase === 'submitting'),
      bobState.wait((s) => s.phase === 'submitting')
    ]);

    const [hostSub, aliceSub, bobSub] = await Promise.all([
      emitAck(host, 'submit-song', { title: 'Host Song', artist: 'Host Artist' }),
      emitAck(alice, 'submit-song', { title: 'Alice Song', artist: 'Alice Artist' }),
      emitAck(bob, 'submit-song', { title: 'Bob Song', artist: 'Bob Artist' })
    ]);
    assert.deepEqual(hostSub, { success: true });
    assert.deepEqual(aliceSub, { success: true });
    assert.deepEqual(bobSub, { success: true });

    host.emit('start-guessing');
    await Promise.all([
      hostState.wait((s) => s.phase === 'guessing'),
      aliceState.wait((s) => s.phase === 'guessing'),
      bobState.wait((s) => s.phase === 'guessing')
    ]);

    const clientsByName = { Host: host, Alice: alice, Bob: bob };
    const statesByName = { Host: hostState, Alice: aliceState, Bob: bobState };

    // Voting plan keyed by [submitterName][voterName] -> { guess, confidence }.
    // Exercises: correct @3 (+3), wrong @2 (-1), wrong @1 (0), and a song where
    // nobody guesses correctly so the submitter earns the +2 stealth bonus.
    const plan = {
      Host: {
        Alice: { guess: 'Host', confidence: 3 },  // correct, confidence 3 -> +3
        Bob: { guess: 'Alice', confidence: 2 }    // wrong, confidence 2 -> -1
      },
      Alice: {
        Host: { guess: 'Bob', confidence: 1 },    // wrong, confidence 1 -> 0
        Bob: { guess: 'Host', confidence: 1 }     // wrong, confidence 1 -> 0 (nobody correct -> stealth +2 to Alice)
      },
      Bob: {
        Host: { guess: 'Bob', confidence: 2 },    // correct, confidence 2 -> +2
        Alice: { guess: 'Host', confidence: 1 }   // wrong, confidence 1 -> 0
      }
    };

    for (let round = 0; round < 3; round++) {
      // Identify the submitter for this shuffled song from each client's own
      // perspective (only the submitter's own game-state has isMySubmission).
      const submitter = ['Host', 'Alice', 'Bob'].find((nm) => {
        const st = statesByName[nm].current;
        return st.currentIndex === round && st.currentSong && st.currentSong.isMySubmission;
      });
      assert.ok(submitter, `expected to identify a submitter for round ${round}`);

      const voters = ['Host', 'Alice', 'Bob'].filter((nm) => nm !== submitter);

      for (const voter of voters) {
        const { guess, confidence } = plan[submitter][voter];
        const ack = await emitAck(clientsByName[voter], 'submit-vote', { guess, confidence });
        assert.deepEqual(ack, { success: true }, `vote by ${voter} should be accepted`);
      }

      // The last vote should auto-trigger reveal -- no host action required.
      const [hostReveal] = await Promise.all([
        hostState.wait((s) => s.phase === 'reveal' && s.currentIndex === round),
        aliceState.wait((s) => s.phase === 'reveal' && s.currentIndex === round),
        bobState.wait((s) => s.phase === 'reveal' && s.currentIndex === round)
      ]);

      const [voterA, voterB] = voters;
      assert.deepEqual(hostReveal.revealVotes[voterA], plan[submitter][voterA]);
      assert.deepEqual(hostReveal.revealVotes[voterB], plan[submitter][voterB]);
      assert.strictEqual(hostReveal.currentSong.submittedBy, submitter);

      host.emit('next-song');
      if (round < 2) {
        await Promise.all([
          hostState.wait((s) => s.phase === 'guessing' && s.currentIndex === round + 1),
          aliceState.wait((s) => s.phase === 'guessing' && s.currentIndex === round + 1),
          bobState.wait((s) => s.phase === 'guessing' && s.currentIndex === round + 1)
        ]);
      }
    }

    const [finalHostState] = await Promise.all([
      hostState.wait((s) => s.phase === 'results'),
      aliceState.wait((s) => s.phase === 'results'),
      bobState.wait((s) => s.phase === 'results')
    ]);

    // Host: 0 (submitter, no vote) + 0 (wrong@1 vs Alice) + 2 (correct@2 vs Bob) = 2
    // Alice: 3 (correct@3 vs Host) + 2 (stealth bonus as submitter) + 0 (wrong@1 vs Bob) = 5
    // Bob: -1 (wrong@2 vs Host) + 0 (wrong@1 vs Alice) + 0 (submitter, nobody stole) = -1
    assert.deepEqual(finalHostState.scores, { Host: 2, Alice: 5, Bob: -1 });
  } finally {
    host.close();
    alice.close();
    bob.close();
  }
});

test('join validation errors', { timeout: 10000 }, async () => {
  const clients = [];
  try {
    const prober = await connectClient();
    clients.push(prober);

    // 'I' is never used by the server's code generator, so this code is
    // guaranteed to never collide with a real room.
    const notFound = await emitAck(prober, 'join-room', { name: 'Someone', code: 'IIII' });
    assert.deepEqual(notFound, { error: 'err_roomNotFound' });

    const owner = await connectClient();
    clients.push(owner);
    const created = await emitAck(owner, 'create-room', 'Owner');
    const code = created.code;

    const firstDup = await connectClient();
    clients.push(firstDup);
    assert.deepEqual(await emitAck(firstDup, 'join-room', { name: 'Dup', code }), { success: true });

    const secondDup = await connectClient();
    clients.push(secondDup);
    assert.deepEqual(await emitAck(secondDup, 'join-room', { name: 'Dup', code }), { error: 'err_nameTaken' });

    const emptyNameClient = await connectClient();
    clients.push(emptyNameClient);
    const emptyNameResult = await emitAck(emptyNameClient, 'join-room', { name: '', code });
    assert.strictEqual(emptyNameResult.error, 'err_invalidNameLength');
  } finally {
    clients.forEach((c) => c.close());
  }
});

test('room state basics', { timeout: 10000 }, async () => {
  const host = await connectClient();
  const guest = await connectClient();
  try {
    const hostState = makeStateWaiter(host);
    const guestState = makeStateWaiter(guest);

    const created = await emitAck(host, 'create-room', 'Solo');
    const code = created.code;

    const initial = await hostState.wait((s) => s.phase === 'lobby');
    assert.strictEqual(initial.phase, 'lobby');
    assert.strictEqual(initial.isHost, true);
    assert.strictEqual(initial.roomCode, code);
    assert.strictEqual(initial.players.length, 1);

    const joinAck = await emitAck(guest, 'join-room', { name: 'Buddy', code });
    assert.deepEqual(joinAck, { success: true });

    const afterJoin = await hostState.wait((s) => s.players.length === 2);
    assert.strictEqual(afterJoin.players.length, 2);
    assert.strictEqual(afterJoin.totalPlayers, 2);

    const guestInitial = await guestState.wait((s) => s.phase === 'lobby');
    assert.strictEqual(guestInitial.isHost, false);
    assert.strictEqual(guestInitial.players.length, 2);
  } finally {
    host.close();
    guest.close();
  }
});

// Regression guard: server.js handlers once crashed the whole process on
// malformed payloads (unguarded `data.someField` access and unconditional
// ack `callback(...)` calls threw uncaught exceptions inside socket.io
// handlers). This test fires those exact payloads and proves the process
// stays alive and functional afterwards.
test('malformed payload resilience', { timeout: 15000 }, async () => {
  const host = await connectClient();
  const guest = await connectClient();
  const hostState = makeStateWaiter(host);

  const created = await emitAck(host, 'create-room', 'MalformedHost');
  const code = created.code;
  await emitAck(guest, 'join-room', { name: 'MalformedGuest', code });

  // Get into 'submitting' phase so payload-dependent handlers actually reach
  // their vulnerable code paths rather than short-circuiting on phase checks.
  host.emit('start-round');
  await hostState.wait((s) => s.phase === 'submitting').catch(() => {});

  // Fire malformed payloads at every handler named in the task. Each call is
  // given a short timeout since a crashed server will never send an ack; we
  // don't hard-assert on each individual response because some are
  // incidentally safe under the current code (e.g. submit-vote's `guess`
  // membership check happens to guard the confidence-parsing line) -- the
  // real proof point is the final liveness check below.
  const malformedAttempts = [
    ['submit-song', null],
    ['submit-vote', { confidence: 'abc' }],
    ['create-room', 12345],
    ['create-room', null],
    ['create-room', {}],
    ['join-room', null],
    ['rejoin', null]
  ];

  for (const [event, payload] of malformedAttempts) {
    try {
      await emitAck(host, event, payload, 1200);
    } catch {
      // Timeout/disconnect is an acceptable outcome for this loop -- it just
      // means the process already went down from an earlier malformed call.
    }
  }

  // Emits with no ack callback at all: create-room/join-room/rejoin call
  // callback(...) unconditionally, so a client that omits the ack function
  // will trigger "callback is not a function" if the server is still alive.
  host.emit('create-room', 'NoAckName');
  host.emit('join-room', { name: 'NoAckName2', code });

  // Proof of resilience: the server process must still accept brand new
  // connections and handle a completely normal request afterwards.
  const freshClient = await connectClient();
  try {
    const proof = await emitAck(freshClient, 'create-room', 'StillAliveCheck');
    assert.ok(
      proof && typeof proof.code === 'string' && proof.code.length === 4,
      'server should still accept and correctly handle normal requests after malformed input'
    );
  } finally {
    freshClient.close();
  }

  host.close();
  guest.close();
});
