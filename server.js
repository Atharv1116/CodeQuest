// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // configure CORS as needed for dev
  cors: {
    origin: '*'
  }
});

// ---------- MongoDB Models ----------
const questionSchema = new mongoose.Schema({
  title: String,
  description: String,
  inputFormat: String,
  outputFormat: String,
  sampleInput: String,
  sampleOutput: String,
  difficulty: String,
  language: String,
  solution: String
});
const Question = mongoose.model('Question', questionSchema);

const playerSchema = new mongoose.Schema({
  socketId: String,
  rating: { type: Number, default: 1000 },
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 },
  matches: { type: Number, default: 0 }
});
const Player = mongoose.model('Player', playerSchema);

const matchSchema = new mongoose.Schema({
  roomId: String,
  players: [String],
  winner: String,
  timestamp: { type: Date, default: Date.now }
});
const Match = mongoose.model('Match', matchSchema);

// ---------- Static & JSON ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- MongoDB Connection ----------
mongoose.connect('mongodb://localhost:27017/codebattle', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("MongoDB error:", err));

// ---------- In-memory queues & room state ----------
let queue1v1 = []; // array of socket objects
let queue2v2 = []; // array of socket objects

// room -> question
const roomQuestion = new Map();
// room -> { type: '1v1'|'2v2', players: [socketId...], teams?: { red: [ids], blue: [ids] }, finished: boolean, winnerTeam?: 'red'|'blue' or winnerId }
const roomState = new Map();

// ---------- ELO Calculation ----------
function calculateElo(winnerRating, loserRating, k = 32) {
  const expectedWin = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  const winnerNew = winnerRating + k * (1 - expectedWin);
  const loserNew = loserRating - k * (1 - expectedWin);
  return [Math.round(winnerNew), Math.round(loserNew)];
}

// ---------- Judge0 configuration ----------
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || '1331538818msh94e20c66f87ea29p1905fcjsnf6c4c3ee1062';
const JUDGE0_HOST = process.env.JUDGE0_HOST || 'judge0-ce.p.rapidapi.com';
const JUDGE0_BASE = `https://${JUDGE0_HOST}`;

// helper: submit to Judge0 and poll until result available
async function submitToJudge0({ source_code, language_id, stdin }) {
  try {
    const postResp = await axios.post(`${JUDGE0_BASE}/submissions`, {
      source_code,
      language_id,
      stdin,
      // we request stdout field, etc by default
    }, {
      headers: {
        'X-RapidAPI-Key': '1331538818msh94e20c66f87ea29p1905fcjsnf6c4c3ee1062',
        'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
        'Content-Type': 'application/json'
      }
    });

    const token = postResp.data.token;
    // Polling loop
    for (let tries = 0; tries < 20; tries++) {
      await new Promise(r => setTimeout(r, 1000)); // wait 1s between polls
      const res = await axios.get(`${JUDGE0_BASE}/submissions/${token}`, {
        headers: {
          'X-RapidAPI-Key': '1331538818msh94e20c66f87ea29p1905fcjsnf6c4c3ee1062',
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
        },
        params: { base64_encoded: 'false', fields: '*' }
      });
      if (res.data && res.data.status && res.data.status.id >= 3) { // >=3 means finished (Accepted/WA/TLE/RE etc)
        return res.data;
      }
    }
    return { status: { description: 'Time limit waiting for Judge0' } };
  } catch (err) {
    console.error('Judge0 error', err.message || err);
    throw err;
  }
}

// ---------- REST endpoint (optional) ----------
app.post('/evaluate', async (req, res) => {
  try {
    const { code, language_id, input } = req.body;
    const result = await submitToJudge0({ source_code: code, language_id, stdin: input || '' });
    res.json(result);
  } catch (err) {
    res.status(500).send('Code evaluation failed');
  }
});

// Leaderboard
app.get('/leaderboard', async (req, res) => {
  const players = await Player.find().sort({ rating: -1 }).limit(10);
  res.json(players);
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // helper to safely get a random question (fallback if none)
  async function getRandomQuestion() {
    const q = await Question.aggregate([{ $sample: { size: 1 } }]);
    if (!q || q.length === 0) {
      // create a default dummy question if DB empty
      return {
        title: 'Default Echo',
        description: 'Echo input to output',
        sampleInput: 'hello',
        sampleOutput: 'hello',
        inputFormat: 'string',
        outputFormat: 'string',
        difficulty: 'easy',
        language: 'any'
      };
    }
    return q[0];
  }

  // ---------- Matchmaking: 1v1 ----------
  socket.on('join-1v1', async () => {
    // avoid duplicate entries
    if (!queue1v1.find(s => s.id === socket.id)) queue1v1.push(socket);

    if (queue1v1.length >= 2) {
      const [player1, player2] = queue1v1.splice(0, 2);
      const roomId = `room_${Date.now()}_${Math.floor(Math.random()*1000)}`;

      // join both to room
      [player1, player2].forEach(p => p.join(roomId));

      // pick question once (same for both)
      const question = await getRandomQuestion();
      roomQuestion.set(roomId, question);
      roomState.set(roomId, {
        type: '1v1',
        players: [player1.id, player2.id],
        finished: false
      });

      // emit to both
      io.to(roomId).emit('match-found', {
        roomId,
        players: [player1.id, player2.id],
        type: '1v1',
        question
      });
    } else {
      socket.emit('queued', { mode: '1v1' });
    }
  });

  // ---------- Matchmaking: 2v2 ----------
  socket.on('join-2v2', async () => {
    if (!queue2v2.find(s => s.id === socket.id)) queue2v2.push(socket);

    if (queue2v2.length >= 4) {
      const players = queue2v2.splice(0, 4);
      const roomId = `room_${Date.now()}_${Math.floor(Math.random()*1000)}`;

      players.forEach(p => p.join(roomId));

      const teamRed = [players[0].id, players[1].id];
      const teamBlue = [players[2].id, players[3].id];

      const question = await getRandomQuestion();
      roomQuestion.set(roomId, question);
      roomState.set(roomId, {
        type: '2v2',
        players: [...teamRed, ...teamBlue],
        teams: { red: teamRed, blue: teamBlue },
        finished: false
      });

      // Emit match-found to each player with their team/opponents
      players.forEach(p => {
        const isRed = teamRed.includes(p.id);
        p.emit('match-found', {
          roomId,
          type: '2v2',
          team: isRed ? 'red' : 'blue',
          teammates: isRed ? teamRed : teamBlue,
          opponents: isRed ? teamBlue : teamRed,
          question
        });
      });
    } else {
      socket.emit('queued', { mode: '2v2' });
    }
  });

  // join-room (explicit)
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit('user-joined', socket.id);
  });

  // chat
  socket.on('send-message', ({ roomId, message }) => {
    socket.to(roomId).emit('receive-message', { user: socket.id, message });
  });

  // Internal helper: update players DB record or create
  async function ensurePlayer(socketId) {
    const p = await Player.findOneAndUpdate(
      { socketId },
      { $setOnInsert: { socketId }, $inc: {} },
      { upsert: true, new: true }
    );
    return p;
  }

  // track if a room has been scored already (to prevent double-wins)
  // store in roomState (finished flag). We'll consult that before awarding.
  // ---------- code submission flow ----------
  // Client emits 'submit-code' with { roomId, code, language_id } and optionally client-side input override.
  socket.on('submit-code', async ({ roomId, code, language_id, inputOverride }) => {
    try {
      const state = roomState.get(roomId);
      const question = roomQuestion.get(roomId);

      if (!state || !question) {
        socket.emit('evaluation-result', { ok: false, message: 'Room or question not found' });
        return;
      }
      if (state.finished) {
        socket.emit('evaluation-result', { ok: false, message: 'Match already finished' });
        return;
      }

      // send to judge0
      socket.emit('evaluation-started', { message: 'Evaluating...' });
      const judgeRes = await submitToJudge0({
        source_code: code,
        language_id,
        stdin: inputOverride !== undefined ? String(inputOverride) : (question.sampleInput || '')
      });

      // judgeRes may contain stdout or compile output
      const stdout = (judgeRes.stdout || '').trim();
      const expected = (question.sampleOutput || '').trim();

      // convenience: if judge returned stderr / compile_output then include in reply
      const details = {
        status: judgeRes.status ? judgeRes.status.description : undefined,
        stdout,
        stderr: judgeRes.stderr,
        compile_output: judgeRes.compile_output,
        time: judgeRes.time,
        memory: judgeRes.memory
      };

      // Compare outputs (simple trim equality). In real system you'd do more robust comparison.
      const correct = stdout === expected;

      if (correct) {
        // For 1v1 -> the submitting socket wins.
        // For 2v2 -> the submitting socket's team wins (all teammates considered winners).
        if (state.type === '1v1') {
          const winnerId = socket.id;
          // find opponent
          const opponentId = state.players.find(id => id !== winnerId);

          // ensure upsert players
          const winner = await Player.findOneAndUpdate(
            { socketId: winnerId },
            { $inc: { wins: 1, matches: 1 } },
            { upsert: true, new: true }
          );
          const loser = await Player.findOneAndUpdate(
            { socketId: opponentId },
            { $inc: { losses: 1, matches: 1 } },
            { upsert: true, new: true }
          );

          // calculate ELO
          const [newWinnerRating, newLoserRating] = calculateElo(winner.rating, loser.rating);
          winner.rating = newWinnerRating;
          loser.rating = newLoserRating;
          await winner.save();
          await loser.save();

          // persist match
          await Match.create({
            roomId,
            players: [winnerId, opponentId],
            winner: winnerId
          });

          // mark finished so no duplicate scoring
          state.finished = true;
          state.winner = winnerId;
          roomState.set(roomId, state);

          io.to(roomId).emit('match-finished', {
            roomId,
            winner: winnerId,
            message: `✅ ${winnerId} (You) solved it.`
          });

          io.to(roomId).emit('score-update', {
            user: winnerId,
            message: `✅ Correct! You win. Rating: ${newWinnerRating}`
          });
          io.to(roomId).emit('score-update', {
            user: opponentId,
            message: `❌ You lost. Rating: ${newLoserRating}`
          });

          // send evaluation details to the room and the submitter
          socket.emit('evaluation-result', { ok: true, correct: true, details });
          socket.to(roomId).emit('opponent-solved', { solver: socket.id, details });

        } else if (state.type === '2v2') {
          // determine which team the submitting player belongs to
          const teams = state.teams || {};
          const isRed = teams.red && teams.red.includes(socket.id);
          const teamName = isRed ? 'red' : 'blue';
          const winningTeam = teams[teamName];
          const losingTeam = teams[teamName === 'red' ? 'blue' : 'red'];

          // mark finished
          state.finished = true;
          state.winnerTeam = teamName;
          roomState.set(roomId, state);

          // compute team average rating
          const winnerPlayers = await Player.find({ socketId: { $in: winningTeam } });
          const loserPlayers = await Player.find({ socketId: { $in: losingTeam } });

          // ensure any missing players exist
          for (const sid of winningTeam) {
            if (!winnerPlayers.find(p => p.socketId === sid)) {
              await Player.create({ socketId: sid });
            }
          }
          for (const sid of losingTeam) {
            if (!loserPlayers.find(p => p.socketId === sid)) {
              await Player.create({ socketId: sid });
            }
          }

          // reload players after upserts
          const winnersNow = await Player.find({ socketId: { $in: winningTeam } });
          const losersNow = await Player.find({ socketId: { $in: losingTeam } });

          const avgWinnerRating = winnersNow.reduce((s, p) => s + p.rating, 0) / winnersNow.length;
          const avgLoserRating = losersNow.reduce((s, p) => s + p.rating, 0) / losersNow.length;

          // compute ELO delta using average ratings
          const [newAvgWinnerRating, newAvgLoserRating] = calculateElo(avgWinnerRating, avgLoserRating);

          // compute per-player new rating by applying the delta proportionally
          const winnerDelta = newAvgWinnerRating - Math.round(avgWinnerRating);
          const loserDelta = newAvgLoserRating - Math.round(avgLoserRating);

          // update each winner player record
          for (const p of winnersNow) {
            p.rating = Math.max(0, p.rating + winnerDelta);
            p.wins = (p.wins || 0) + 1;
            p.matches = (p.matches || 0) + 1;
            await p.save();
          }

          // update each loser player record
          for (const p of losersNow) {
            p.rating = Math.max(0, p.rating + loserDelta);
            p.losses = (p.losses || 0) + 1;
            p.matches = (p.matches || 0) + 1;
            await p.save();
          }

          // persist team match
          await Match.create({
            roomId,
            players: [...winningTeam, ...losingTeam],
            winner: teamName
          });

          // emit results
          io.to(roomId).emit('match-finished', {
            roomId,
            winnerTeam: teamName,
            winningPlayers: winningTeam,
            message: `✅ Team ${teamName} wins!`
          });

          // send per-player score updates
          for (const p of winnersNow) {
            io.to(roomId).emit('score-update', {
              user: p.socketId,
              message: `✅ Team win. New rating: ${p.rating}`
            });
          }
          for (const p of losersNow) {
            io.to(roomId).emit('score-update', {
              user: p.socketId,
              message: `❌ Team lost. New rating: ${p.rating}`
            });
          }

          socket.emit('evaluation-result', { ok: true, correct: true, details });

        } else {
          socket.emit('evaluation-result', { ok: false, message: 'Unknown match type' });
        }

      } else {
        // Wrong output — don't finish match
        socket.emit('evaluation-result', { ok: true, correct: false, details });
        io.to(roomId).emit('score-update', {
          user: socket.id,
          message: '❌ Wrong Output'
        });
      }

    } catch (err) {
      console.error('submit-code error', err && err.message ? err.message : err);
      socket.emit('evaluation-result', { ok: false, message: 'Server evaluation failed' });
    }
  });

  // disconnect cleanup
  socket.on('disconnect', () => {
    queue1v1 = queue1v1.filter(s => s.id !== socket.id);
    queue2v2 = queue2v2.filter(s => s.id !== socket.id);

    // If the user was part of any room state, leave them but keep other players informed:
    for (const [roomId, state] of roomState.entries()) {
      if (state.players && state.players.includes(socket.id) && !state.finished) {
        // notify room
        io.to(roomId).emit('player-disconnected', { socketId: socket.id });
        // optional: mark match finished as cancelled
        state.finished = true;
        state.winner = null;
        roomState.set(roomId, state);
      }
    }

    console.log(`❌ Disconnected: ${socket.id}`);
  });

});

// start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
