const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ───────────────────────────────────────────────
const rooms = {};
const disconnectTimers = {}; // name:roomCode -> timeout

const PROMPT_COUNT = 20;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60000;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateCode() : code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcastState(code) {
  const room = rooms[code];
  if (!room) return;

  const currentSong = (room.phase === 'guessing' || room.phase === 'reveal')
    ? room.shuffledSongs[room.currentIndex]
    : null;

  const activePlayerCount = room.players.filter(p => !room.midRoundJoiners.has(p.name)).length;

  room.players.forEach(p => {
    const isHost = p.socketId === room.hostSocketId;
    const isSubmitter = currentSong && currentSong.submittedBy === p.name;
    const isSpectator = room.midRoundJoiners.has(p.name);

    const state = {
      phase: room.phase,
      prompt: room.prompt,
      players: room.players.map(pl => pl.name),
      hostName: room.hostName,
      isHost,
      isSpectator,
      myName: p.name,
      currentIndex: room.currentIndex,
      totalSongs: room.shuffledSongs.length || 0,
      scores: room.scores,
      submittedCount: Object.keys(room.submissions).length,
      totalPlayers: activePlayerCount,
      currentSong: currentSong ? {
        title: currentSong.title,
        artist: currentSong.artist,
        submittedBy: room.phase === 'reveal' ? currentSong.submittedBy : null,
        youtubeQuery: encodeURIComponent(`${currentSong.artist} ${currentSong.title} official audio`),
        isMySubmission: isSubmitter
      } : null,
      votedCount: Object.keys(room.votes).length,
      eligibleVoters: activePlayerCount - 1,
      hasVoted: !!room.votes[p.name],
      hasSubmitted: !!room.submissions[p.name],
      revealVotes: room.phase === 'reveal' ? room.votes : null,
      roundNumber: room.roundNumber,
      nobodyGuessed: room.phase === 'reveal'
        ? !Object.values(room.votes).some(v => v.guess === currentSong.submittedBy)
        : false,
      roomCode: code
    };
    io.to(p.socketId).emit('game-state', state);
  });
}

function performReveal(room, code) {
  const currentSong = room.shuffledSongs[room.currentIndex];

  // Score calculation
  Object.entries(room.votes).forEach(([voter, vote]) => {
    if (vote.guess === currentSong.submittedBy) {
      room.scores[voter] = (room.scores[voter] || 0) + vote.confidence;
    } else {
      if (vote.confidence > 1) {
        room.scores[voter] = (room.scores[voter] || 0) - (vote.confidence - 1);
      }
    }
  });

  // Stealth bonus: nobody guessed correctly
  const anyCorrect = Object.values(room.votes).some(v => v.guess === currentSong.submittedBy);
  if (!anyCorrect && Object.keys(room.votes).length > 0) {
    room.scores[currentSong.submittedBy] = (room.scores[currentSong.submittedBy] || 0) + 2;
  }

  room.phase = 'reveal';
  broadcastState(code);
}

// ─── Socket Events ────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('create-room', (name, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    if (typeof name !== 'string') return ack({ error: 'err_invalidName' });
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 20) return ack({ error: 'err_invalidName' });

    const code = generateCode();
    rooms[code] = {
      code,
      hostSocketId: socket.id,
      hostName: trimmed,
      phase: 'lobby',
      prompt: '',
      players: [{ name: trimmed, socketId: socket.id }],
      submissions: {},
      shuffledSongs: [],
      currentIndex: 0,
      votes: {},
      scores: { [trimmed]: 0 },
      roundNumber: 0,
      prompts: shuffle(Array.from({length: PROMPT_COUNT}, (_, i) => i)),
      midRoundJoiners: new Set()
    };

    currentRoom = code;
    currentName = trimmed;
    socket.join(code);
    ack({ code });
    broadcastState(code);
  });

  socket.on('join-room', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return ack({ error: 'err_invalidNameLength' });
    const code = (typeof data.code === 'string' ? data.code : '').toUpperCase().trim();
    const name = (typeof data.name === 'string' ? data.name : '').trim();

    if (!name || name.length > 20) return ack({ error: 'err_invalidNameLength' });

    const room = rooms[code];
    if (!room) return ack({ error: 'err_roomNotFound' });

    // Check if the name belongs to a disconnected player in grace period
    const existingPlayer = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existingPlayer) {
      const timerKey = `${existingPlayer.name}:${code}`;
      if (disconnectTimers[timerKey]) {
        // Cancel disconnect timer and take over the slot
        clearTimeout(disconnectTimers[timerKey]);
        delete disconnectTimers[timerKey];
        existingPlayer.socketId = socket.id;
        if (room.hostName === existingPlayer.name) {
          room.hostSocketId = socket.id;
        }
        currentRoom = code;
        currentName = existingPlayer.name;
        socket.join(code);
        ack({ success: true });
        broadcastState(code);
        return;
      }
      return ack({ error: 'err_nameTaken' });
    }
    if (room.players.length >= 10) return ack({ error: 'err_roomFull' });
    if (room.phase !== 'lobby') {
      room.midRoundJoiners.add(name);
    }

    room.players.push({ name, socketId: socket.id });
    room.scores[name] = 0;
    currentRoom = code;
    currentName = name;
    socket.join(code);
    ack({ success: true });
    broadcastState(code);
  });

  socket.on('start-round', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'lobby' && room.phase !== 'results') return;
    if (room.players.length < 2) return;

    room.roundNumber++;
    room.midRoundJoiners = new Set();
    const idx = (room.roundNumber - 1) % room.prompts.length;
    room.prompt = room.prompts[idx];
    room.phase = 'submitting';
    room.submissions = {};
    room.shuffledSongs = [];
    room.currentIndex = 0;
    room.votes = {};
    broadcastState(currentRoom);
  });

  socket.on('submit-song', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'submitting') return;
    if (room.midRoundJoiners.has(currentName)) return;
    if (!data || typeof data.title !== 'string' || !data.title.trim()) return ack({ error: 'err_songRequired' });

    room.submissions[currentName] = {
      title: data.title.trim().slice(0, 100),
      artist: (typeof data.artist === 'string' ? data.artist : '').trim().slice(0, 100),
      submittedBy: currentName
    };

    ack({ success: true });
    broadcastState(currentRoom);
  });

  socket.on('start-guessing', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'submitting') return;
    if (Object.keys(room.submissions).length < 2) return;

    room.shuffledSongs = shuffle(Object.values(room.submissions));
    room.currentIndex = 0;
    room.votes = {};
    room.phase = 'guessing';
    broadcastState(currentRoom);
  });

  socket.on('submit-vote', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'guessing') return;
    if (room.midRoundJoiners.has(currentName)) return;

    const currentSong = room.shuffledSongs[room.currentIndex];
    if (currentName === currentSong.submittedBy) return;

    // Guess must be an actual player in the room
    if (!data || !room.players.some(p => p.name === data.guess)) return ack({ error: 'err_invalidGuess' });

    const confNum = Number(data.confidence);
    room.votes[currentName] = {
      guess: data.guess,
      confidence: Math.min(3, Math.max(1, Number.isNaN(confNum) ? 1 : Math.round(confNum)))
    };

    ack({ success: true });

    const activePlayerCount = room.players.filter(p => !room.midRoundJoiners.has(p.name)).length;
    const eligibleVoters = activePlayerCount - 1;
    if (Object.keys(room.votes).length >= eligibleVoters) {
      performReveal(room, currentRoom);
    } else {
      broadcastState(currentRoom);
    }
  });

  socket.on('reveal', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'guessing') return;
    performReveal(room, currentRoom);
  });

  socket.on('next-song', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== 'reveal') return;

    room.currentIndex++;
    room.votes = {};

    if (room.currentIndex >= room.shuffledSongs.length) {
      room.phase = 'results';
    } else {
      room.phase = 'guessing';
    }
    broadcastState(currentRoom);
  });

  socket.on('back-to-lobby', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    room.phase = 'lobby';
    room.midRoundJoiners = new Set();
    broadcastState(currentRoom);
  });

  socket.on('rejoin', (data, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return ack({ error: 'err_invalidName' });
    const code = (typeof data.code === 'string' ? data.code : '').toUpperCase().trim();
    const name = (typeof data.name === 'string' ? data.name : '').trim();
    if (!code || !name) return ack({ error: 'err_invalidName' });

    const room = rooms[code];
    if (!room) return ack({ error: 'err_roomNotFound' });

    // Cancel pending disconnect timer
    const timerKey = `${name}:${code}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }

    const player = room.players.find(p => p.name === name);
    if (!player) return ack({ error: 'err_playerNotInRoom' });

    // Update socket ID
    player.socketId = socket.id;
    if (room.hostName === name) {
      room.hostSocketId = socket.id;
    }

    currentRoom = code;
    currentName = name;
    socket.join(code);
    ack({ success: true });
    broadcastState(code);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const disconnectedName = currentName;
    const disconnectedRoom = currentRoom;

    // A newer socket has already taken over this player's slot (rejoin landed
    // before this stale socket's disconnect was detected) — do nothing.
    const player = room.players.find(p => p.name === currentName);
    if (player && player.socketId !== socket.id) return;

    // Grace period: wait 60 seconds before removing
    const timerKey = `${disconnectedName}:${disconnectedRoom}`;
    disconnectTimers[timerKey] = setTimeout(() => {
      delete disconnectTimers[timerKey];
      const r = rooms[disconnectedRoom];
      if (!r) return;

      // Belt-and-braces: if the player's current socket is live, skip removal
      const reconnected = r.players.find(p => p.name === disconnectedName);
      if (reconnected) {
        const liveSocket = io.sockets.sockets.get(reconnected.socketId);
        if (liveSocket && liveSocket.connected) return;
      }

      // Remove the disconnected player
      r.players = r.players.filter(p => p.name !== disconnectedName);
      delete r.scores[disconnectedName];
      delete r.submissions[disconnectedName];
      delete r.votes[disconnectedName];
      r.midRoundJoiners.delete(disconnectedName);

      if (r.players.length === 0) {
        // No one left — delete room
        delete rooms[disconnectedRoom];
      } else if (r.hostName === disconnectedName) {
        // Promote new host
        const newHost = r.players[0];
        r.hostName = newHost.name;
        r.hostSocketId = newHost.socketId;
        io.to(disconnectedRoom).emit('host-changed', { name: newHost.name });
        broadcastState(disconnectedRoom);
      } else {
        broadcastState(disconnectedRoom);
      }
    }, DISCONNECT_GRACE_MS);
  });
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  WHO PLAYED THIS?\n  Running on http://localhost:${PORT}\n`);
});
