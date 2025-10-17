// public/battle.js

// Read URL params
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room');
const problemTitle = urlParams.get('title') || 'Untitled Problem';
const problemDesc = urlParams.get('desc') || '';
const inputSample = urlParams.get('input') || '';
const expectedSample = urlParams.get('output') || '';

/* Socket */
const socket = io();

/* UI elements */
const qTitleEl = document.getElementById('question-title');
const qDescEl = document.getElementById('question-description');
const qSampleEl = document.getElementById('question-sample');
const chatBoxEl = document.getElementById('chat');
const chatInputEl = document.getElementById('chat-box');
const outputEl = document.getElementById('output');

/* Fill question area */
qTitleEl.innerText = problemTitle;
qDescEl.innerText = problemDesc;
if (inputSample || expectedSample) {
  qSampleEl.innerText = `Sample Input:\n${inputSample}\n\nSample Output:\n${expectedSample}`;
} else {
  qSampleEl.innerText = '';
}

/* Player mapping: socketId -> label ('You', 'Player 1', 'Player 2', ...) */
const playerOrder = [];
let mySocketId = null;

function getLabelForSocketId(sid) {
  if (sid === mySocketId) return 'You';
  const idx = playerOrder.indexOf(sid);
  if (idx === -1) {
    if (sid !== mySocketId) playerOrder.push(sid);
    return `Player ${playerOrder.indexOf(sid) + 1}`;
  }
  return `Player ${idx + 1}`;
}

/* Join room after socket connected */
socket.on('connect', () => {
  mySocketId = socket.id;
  if (!playerOrder.includes(mySocketId)) playerOrder.unshift(mySocketId);
  if (roomId) {
    socket.emit('join-room', roomId);
  } else {
    console.warn('No roomId in URL - cannot join room.');
  }
});

/* When someone else joins the room */
socket.on('user-joined', (joinedSocketId) => {
  if (!playerOrder.includes(joinedSocketId)) playerOrder.push(joinedSocketId);
  appendChatSystemMessage(`Player joined: ${getLabelForSocketId(joinedSocketId)} (${joinedSocketId})`);
});

/* Chat receive */
socket.on('receive-message', ({ user, message }) => {
  const label = getLabelForSocketId(user);
  appendChatMessage(label, message);
});

/* Score updates */
socket.on('score-update', (data) => {
  const label = getLabelForSocketId(data.user);
  appendChatSystemMessage(`${label}: ${data.message}`);
});

socket.on('match-finished', (data) => {
  if (data.winnerTeam) {
    appendChatSystemMessage(`Team ${data.winnerTeam} won!`);
  } else if (data.winner) {
    appendChatSystemMessage(`Winner: ${getLabelForSocketId(data.winner)} (${data.winner})`);
  } else {
    appendChatSystemMessage('Match finished.');
  }
});

/* Player disconnected */
socket.on('player-disconnected', ({ socketId }) => {
  appendChatSystemMessage(`${getLabelForSocketId(socketId)} disconnected.`);
});

/* Helper to append chat messages */
function appendChatMessage(senderLabel, message) {
  const p = document.createElement('p');
  p.innerHTML = `<strong>${senderLabel}:</strong> ${escapeHtml(message)}`;
  chatBoxEl.appendChild(p);
  chatBoxEl.scrollTop = chatBoxEl.scrollHeight;
}

function appendChatSystemMessage(message) {
  const p = document.createElement('p');
  p.style.opacity = '0.8';
  p.style.fontStyle = 'italic';
  p.textContent = message;
  chatBoxEl.appendChild(p);
  chatBoxEl.scrollTop = chatBoxEl.scrollHeight;
}

/* Escape HTML to avoid injection */
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"'`]/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;'
  }[m]));
}

/* Send chat */
function sendMessage() {
  const msg = chatInputEl.value.trim();
  if (!msg) return;
  if (!roomId) {
    alert('No room id found.');
    return;
  }
  socket.emit('send-message', { roomId, message: msg });
  appendChatMessage('You', msg);
  chatInputEl.value = '';
}

/* Monaco editor initialization for Python */
let editor = null;
function initMonaco() {
  if (window.require && window.monaco) {
    editor = monaco.editor.create(document.getElementById('editor'), {
      value: '# Write your Python code here\n',
      language: 'python',
      theme: 'vs-dark',
      automaticLayout: true
    });
    return;
  }

  if (typeof require === 'function') {
    require.config({ paths: { 'vs': 'https://unpkg.com/monaco-editor@0.45.0/min/vs' }});
    require(['vs/editor/editor.main'], function () {
      editor = monaco.editor.create(document.getElementById('editor'), {
        value: '# Write your Python code here\n',
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true
      });
    });
  } else {
    appendChatSystemMessage('Monaco loader not found.');
  }
}

/* Initialize Monaco when page loads */
document.addEventListener('DOMContentLoaded', () => {
  initMonaco();
});

/* Submit code */
async function submitCode() {
  if (!editor) {
    alert('Editor not ready yet.');
    return;
  }
  const code = editor.getValue();
  if (!code.trim()) {
    alert('Please write some code before submitting.');
    return;
  }

  appendChatSystemMessage('Submitting Python code to Judge0...');

  try {
    const resp = await fetch('/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        language_id: 71, // ✅ Python 3 (Judge0)
        input: inputSample
      })
    });

    const result = await resp.json();

    socket.emit('submit-code', { roomId, result, expected: expectedSample });

    outputEl.innerText = JSON.stringify(result, null, 2);
  } catch (err) {
    appendChatSystemMessage('Error submitting code: ' + (err.message || err));
  }
}

/* Expose functions */
window.sendMessage = sendMessage;
window.submitCode = submitCode;
