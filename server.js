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
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 20) return callback({ error: 'err_invalidName' });

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
    callback({ code });
    broadcastState(code);
  });

  socket.on('join-room', (data, callback) => {
    const code = (data.code || '').toUpperCase().trim();
    const name = (data.name || '').trim();

    if (!name || name.length > 20) return callback({ error: 'err_invalidNameLength' });

    const room = rooms[code];
    if (!room) return callback({ error: 'err_roomNotFound' });
    if (room.players.find(p => p.name.toLowerCase() === name.toLowerCase()))
      return callback({ error: 'err_nameTaken' });
    if (room.players.length >= 10) return callback({ error: 'err_roomFull' });
    if (room.phase !== 'lobby') {
      room.midRoundJoiners.add(name);
    }

    room.players.push({ name, socketId: socket.id });
    room.scores[name] = 0;
    currentRoom = code;
    currentName = name;
    socket.join(code);
    callback({ success: true });
    broadcastState(code);
  });

  socket.on('start-round', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
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
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'submitting') return;
    if (room.midRoundJoiners.has(currentName)) return;
    if (!data.title?.trim()) return callback?.({ error: 'err_songRequired' });

    room.submissions[currentName] = {
      title: data.title.trim(),
      artist: (data.artist || '').trim(),
      submittedBy: currentName
    };

    callback?.({ success: true });
    broadcastState(currentRoom);
  });

  socket.on('start-guessing', () => {
    const room = rooms[currentRoom];
    if (!room || socket.id !== room.hostSocketId) return;
    if (Object.keys(room.submissions).length < 2) return;

    room.shuffledSongs = shuffle(Object.values(room.submissions));
    room.currentIndex = 0;
    room.votes = {};
    room.phase = 'guessing';
    broadcastState(currentRoom);
  });

  socket.on('submit-vote', (data, callback) => {
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'guessing') return;
    if (room.midRoundJoiners.has(currentName)) return;

    const currentSong = room.shuffledSongs[room.currentIndex];
    if (currentName === currentSong.submittedBy) return;

    room.votes[currentName] = {
      guess: data.guess,
      confidence: Math.min(3, Math.max(1, data.confidence || 1))
    };

    callback?.({ success: true });

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
    const code = (data.code || '').toUpperCase().trim();
    const name = (data.name || '').trim();
    if (!code || !name) return callback({ error: 'err_invalidName' });

    const room = rooms[code];
    if (!room) return callback({ error: 'err_roomNotFound' });

    // Cancel pending disconnect timer
    const timerKey = `${name}:${code}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }

    const player = room.players.find(p => p.name === name);
    if (!player) return callback({ error: 'err_playerNotInRoom' });

    // Update socket ID
    player.socketId = socket.id;
    if (room.hostName === name) {
      room.hostSocketId = socket.id;
    }

    currentRoom = code;
    currentName = name;
    socket.join(code);
    callback({ success: true });
    broadcastState(code);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const disconnectedName = currentName;
    const disconnectedRoom = currentRoom;

    // Grace period: wait 60 seconds before removing
    const timerKey = `${disconnectedName}:${disconnectedRoom}`;
    disconnectTimers[timerKey] = setTimeout(() => {
      delete disconnectTimers[timerKey];
      const r = rooms[disconnectedRoom];
      if (!r) return;

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
    }, 60000);
  });
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  WHO PLAYED THIS?\n  Running on http://localhost:${PORT}\n`);
});
