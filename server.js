const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const Redis = require('redis'); // Optional: For prod scaling

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware
// Custom Helmet with relaxed CSP for dev (external scripts + inline)
// Custom Helmet with full CSP for dev (allows CDNs, inline handlers as fallback, source maps)
// Custom Helmet with Permissions Policy for YouTube
// Custom Helmet with full CSP for YouTube (including frames)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdn.socket.io",
        "https://www.youtube.com",
        "https://www.gstatic.com"
      ],
      scriptSrcAttr: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      connectSrc: [
        "'self'",
        "http://localhost:3000",
        "ws://localhost:3000",
        "https://cdn.socket.io",
        "https://www.youtube.com"
      ],
      frameSrc: [  // New: Allows YouTube iframes
        "'self'",
        "https://www.youtube.com"
      ],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com", "https://*.ytimg.com"],
      mediaSrc: ["'self'", "https://*.youtube.com", "blob:"],
      workerSrc: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  permissionsPolicy: {
    features: {
      autoplay: ["'self'", "https://www.youtube.com"],
      encryptedMedia: ["'self'", "https://www.youtube.com"],
      accelerometer: ["'self'"],
      gyroscope: ["'self'"],
      pictureInPicture: ["'self'", "https://www.youtube.com"],
      clipboardWrite: ["'self'"],
      webShare: ["'self'"]
    }
  },
  hsts: false
}));
// app.use((req, res, next) => {
//   res.set('Permissions-Policy', [
//     'autoplay=(self "https://www.youtube.com")',
//     'encrypted-media=(self "https://www.youtube.com")',
//     'accelerometer=(self)',
//     'gyroscope=(self)',
//     'picture-in-picture=(self "https://www.youtube.com")',
//     'clipboard-write=(self)',
//     'web-share=(self)'
//   ].join('; '));
//   next();
// });
app.use(compression()); // Performance
app.use(cors()); // Cross-OS/browser
app.use(express.json()); // Body parsing
app.use(express.static(__dirname));  // Serves index.html from the folder
app.use(express.static('.'));  // Serves index.html and other files

// Optional Redis Adapter for Multi-Server Scaling
let redisAdapter;
let redisClient;
if (process.env.REDIS_URL) {
  redisClient = Redis.createClient({ url: process.env.REDIS_URL });
  redisClient.connect().catch(console.error);
  redisAdapter = new (require('socket.io-redis'))({
    host: process.env.REDIS_HOST || 'localhost',
    port: 6379
  });
  io.adapter(redisAdapter);
}

// In-Memory Storage (Use Redis in prod)
const rooms = new Map(); // { roomCode: { hostId, media: {type: 'youtube|spotify', id: '...'}, users: [] } }
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase(); // e.g., ABC123

// Socket Connection
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join Room
  socket.on('join-room', ({ roomCode, userName }) => {
    if (!rooms.has(roomCode)) {
      return socket.emit('error', { msg: 'Room not found' });
    }

    socket.join(roomCode);
    const room = rooms.get(roomCode);
    room.users.push({ id: socket.id, name: userName });
    socket.to(roomCode).emit('user-joined', { name: userName });

    // Send room state to new user
    socket.emit('room-state', {
      media: room.media,
      queue: room.queue,  // New
      currentIndex: room.currentIndex,  // New
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      hostId: room.hostId,
      users: room.users.map(u => u.name)
    });

    console.log(`${userName} joined ${roomCode}`);
  });

  // Create Room
  socket.on('create-room', ({ userName }) => {
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (rooms.has(roomCode));

    rooms.set(roomCode, {
      hostId: socket.id,
      media: null,  // Current video
      queue: [],    // New: Array of {type: 'youtube', id: '...'}
      currentIndex: 0,  // Queue position
      isPlaying: false,
      currentTime: 0,
      users: [{ id: socket.id, name: userName }]
    });

    socket.emit('room-created', { roomCode });
    socket.join(roomCode);
    console.log(`${userName} created ${roomCode}`);
  });

  // Load Media (YouTube/Spotify)
  socket.on('load-media', ({ roomCode, media, addToQueue = false }) => {  // New param
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const room = rooms.get(roomCode);
    if (addToQueue) {
      room.queue.push(media);
    } else {
      room.media = media;
      room.currentIndex = 0;
      room.queue = [media];  // Start new queue
    }
    io.to(roomCode).emit('media-updated', { media, queue: room.queue, currentIndex: room.currentIndex });
  });

  // Sync Controls (The Rave Magic)
  socket.on('play', ({ roomCode, currentTime }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const timestamp = Date.now();
    rooms.get(roomCode).isPlaying = true;
    rooms.get(roomCode).currentTime = currentTime;

    // Broadcast with compensation
    io.to(roomCode).emit('sync-play', {
      currentTime,
      timestamp,
      offset: 0 // Clients calculate: seekTo = currentTime + (now - timestamp)/1000
    });
  });

  socket.on('pause', ({ roomCode }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const timestamp = Date.now();
    rooms.get(roomCode).isPlaying = false;

    io.to(roomCode).emit('sync-pause', { timestamp });
  });

  socket.on('seek', ({ roomCode, newTime }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const timestamp = Date.now();
    rooms.get(roomCode).currentTime = newTime;

    io.to(roomCode).emit('sync-seek', { newTime, timestamp });
  });

    socket.on('next-video', ({ roomCode }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const room = rooms.get(roomCode);
    room.currentIndex = (room.currentIndex + 1) % room.queue.length;
    room.media = room.queue[room.currentIndex];
    room.currentTime = 0;
    room.isPlaying = false;

    io.to(roomCode).emit('media-updated', { media: room.media, queue: room.queue, currentIndex: room.currentIndex });
    io.to(roomCode).emit('sync-seek', { newTime: 0, timestamp: Date.now() });
  });

  socket.on('prev-video', ({ roomCode }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    if (rooms.get(roomCode).hostId !== socket.id) return;

    const room = rooms.get(roomCode);
    room.currentIndex = (room.currentIndex - 1 + room.queue.length) % room.queue.length;
    room.media = room.queue[room.currentIndex];
    room.currentTime = 0;
    room.isPlaying = false;

    io.to(roomCode).emit('media-updated', { media: room.media, queue: room.queue, currentIndex: room.currentIndex });
    io.to(roomCode).emit('sync-seek', { newTime: 0, timestamp: Date.now() });
  });

  // Chat (fixed: proper user lookup from room data)
  socket.on('send-chat', ({ roomCode, message, userName }) => {
    if (!rooms.has(roomCode) || !socket.rooms.has(roomCode)) return;
    
    // Find user by socket ID
    const room = rooms.get(roomCode);
    const user = room.users.find(u => u.id === socket.id);
    
    if (!user) return;  // Safety check
    
    const chatData = {
      user: user.name,   // Pulled from stored user data
      message,
      timestamp: Date.now()
    };
    
    io.to(roomCode).emit('new-chat', chatData);
  });

  // Voice Signaling (WebRTC – Clients handle ICE/STUN)
  socket.on('voice-offer', ({ roomCode, offer, targetId }) => {
    socket.to(targetId).to(roomCode).emit('voice-offer', { offer, fromId: socket.id });
  });

  socket.on('voice-answer', ({ roomCode, answer, targetId }) => {
    socket.to(targetId).to(roomCode).emit('voice-answer', { answer, fromId: socket.id });
  });

  socket.on('ice-candidate', ({ roomCode, candidate, targetId }) => {
    socket.to(targetId).to(roomCode).emit('ice-candidate', { candidate, fromId: socket.id });
  });

  // Cleanup
  socket.on('disconnect', () => {
    // Remove from all rooms
    for (const roomCode of Array.from(socket.rooms)) {
      if (rooms.has(roomCode) && roomCode !== socket.id) {
        const room = rooms.get(roomCode);
        room.users = room.users.filter(u => u.id !== socket.id);
        io.to(roomCode).emit('user-left', { id: socket.id });
        if (room.hostId === socket.id && room.users.length > 0) {
          room.hostId = room.users[0].id; // Promote next user
        }
        if (room.users.length === 0) rooms.delete(roomCode);
      }
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Health Check
app.get('/health', (req, res) => res.send('OK'));

// Expose Room List (Optional API)
app.get('/rooms', (req, res) => {
  res.json(Array.from(rooms.keys()));
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`RaveClone Backend running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    console.log('Use PM2 or systemd for prod!');
  }
});

module.exports = server; // For testing