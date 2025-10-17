// public/client.js
const socket = io();

function join1v1() {
  socket.emit('join-1v1');
}

function join2v2() {
  socket.emit('join-2v2');
}

// When a match is found, redirect to battle page with problem info in URL
socket.on('match-found', (data) => {
  // data.question is the object stored in DB (title, description, sampleInput, sampleOutput, ...)
  const q = data.question || data.problem || {};
  const query = new URLSearchParams({
    room: data.roomId,
    title: q.title || '',
    desc: q.description || '',
    input: q.sampleInput || '',
    output: q.sampleOutput || ''
  }).toString();

  // redirect to battle page with room and question details
  window.location.href = `/battle.html?${query}`;
});
