const socket = io('http://localhost:3000');
socket.emit('send-chat', { roomCode: 'ABC123', message: 'Hello everyone!', userName: 'Grok' });

// On sync-play

socket.on('sync-play', ({ currentTime, timestamp }) => {
  const offset = (Date.now() - timestamp) / 1000;
  player.seekTo(currentTime + offset, true); // YouTube API
  player.playVideo();
});