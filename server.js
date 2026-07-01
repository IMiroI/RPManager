// ============================================
// server.js — RPManager — Serveur principal
// ============================================
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { GameEngine } = require('./gameEngine');
const rp = require('./roleplaysManager');

const app = express();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3003').split(',');

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGINS } });

const PORT = process.env.PORT || 3001;

// Active sessions: code -> { engine, roleplay, gmSecret, gmSocketId }
const sessions = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    const buf = randomBytes(6);
    code = Array.from(buf).map(b => chars[b % chars.length]).join('');
  } while (sessions.has(code));
  return code;
}

// ─── Middleware ──────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes' },
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Roleplays ───────────────────────────────────
app.get('/api/roleplays', (req, res) => res.json(rp.getAllRoleplays()));

app.get('/api/roleplays/:id', (req, res) => {
  const data = rp.getRoleplay(req.params.id);
  if (!data) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

app.post('/api/roleplays', (req, res) => {
  try {
    const data = rp.createRoleplay(req.body);
    res.status(201).json(data);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(400).json({ error: 'Données invalides' });
  }
});

app.put('/api/roleplays/:id', (req, res) => {
  try {
    const data = rp.updateRoleplay(req.params.id, req.body);
    if (!data) return res.status(404).json({ error: 'Introuvable' });
    res.json(data);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/roleplays/:id', (req, res) => {
  for (const [, session] of sessions) {
    if (session.roleplay.id === req.params.id) {
      return res.status(409).json({ error: 'Une session est en cours pour ce roleplay.' });
    }
  }
  try {
    const ok = rp.deleteRoleplay(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Introuvable' });
    res.json({ success: true });
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── API Sessions ────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  try {
    const roleplay = req.body.roleplay;
    if (!roleplay || !roleplay.name) {
      return res.status(400).json({ error: 'Données du roleplay invalides.' });
    }
    if (!roleplay.characters?.length) {
      return res.status(400).json({ error: 'Ce roleplay n\'a aucun personnage.' });
    }

    const code = generateCode();
    const gmSecret = randomBytes(16).toString('hex');
    sessions.set(code, { engine: new GameEngine(roleplay), roleplay, gmSecret, gmSocketId: null });

    res.json({
      code,
      gmSecret,
      roleplay: { id: roleplay.id, name: roleplay.name, themeColor: roleplay.themeColor }
    });
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/sessions/:code', (req, res) => {
  const session = sessions.get(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  res.json({
    code: req.params.code.toUpperCase(),
    roleplay: { id: session.roleplay.id, name: session.roleplay.name, themeColor: session.roleplay.themeColor },
    phase: session.engine.phase,
    playerCount: session.engine.getConnectedPlayerCount()
  });
});

app.delete('/api/sessions/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    if (!sessions.has(code)) return res.status(404).json({ error: 'Session introuvable' });
    sessions.delete(code);
    res.json({ success: true });
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── Pages ───────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/editor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/editor/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/gm/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gm.html')));
app.get('/player/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

// ─── Socket.io ───────────────────────────────────────
io.on('connection', (socket) => {
  let sessionCode = null;
  let playerRole = null;

  function broadcastPlayerStates(code) {
    const session = sessions.get(code);
    if (!session) return;
    for (const [sid] of session.engine.players) {
      io.to(sid).emit('player:state', session.engine.getPlayerState(sid));
    }
  }

  function isGM(code) {
    const session = sessions.get(code);
    return session && session.gmSocketId === socket.id;
  }

  // ─── GM Events ──────────────────────────────────────
  socket.on('gm:connect', ({ code, gmSecret }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error:session', 'Session introuvable'); return; }
    if (session.gmSecret !== gmSecret) { socket.emit('error:session', 'Accès GM refusé'); return; }

    sessionCode = code;
    playerRole = 'gm';
    session.gmSocketId = socket.id;
    session.engine.setGM(socket.id);
    socket.join(`gm:${code}`);
    socket.emit('session:info', { roleplay: session.roleplay });
    socket.emit('gm:state', session.engine.getGMState());
    console.log(`[MJ] Connecté — Session: ${code}`);
  });

  socket.on('gm:distribute', () => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.distributeCards();
    if (result.success) {
      console.log(`[MJ] Cartes distribuées — ${sessionCode}`);
      broadcastPlayerStates(sessionCode);
      socket.emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('gm:error', result.error);
    }
  });

  socket.on('gm:startGame', () => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.startGame();
    if (result.success) {
      console.log(`[MJ] Partie lancée — ${sessionCode}`);
      for (const [sid] of session.engine.players) {
        io.to(sid).emit('player:state', session.engine.getPlayerState(sid));
        io.to(sid).emit('player:gameStarted');
      }
      socket.emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('gm:error', result.error);
    }
  });

  socket.on('gm:revealSkill', ({ playerSocketId, skillId }) => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.revealSkill(playerSocketId, skillId);
    if (result.success) {
      io.to(playerSocketId).emit('player:skillRevealed', result.skill);
      io.to(playerSocketId).emit('player:state', session.engine.getPlayerState(playerSocketId));
      socket.emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('gm:error', result.error);
    }
  });

  socket.on('gm:message', ({ playerSocketId, message }) => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    if (typeof message !== 'string' || message.trim().length === 0) return;
    const safeMessage = message.trim().slice(0, 1000);

    const result = session.engine.sendPrivateMessage(playerSocketId, safeMessage);
    if (result.success) {
      io.to(playerSocketId).emit('player:privateMessage', result.message);
      socket.emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('gm:error', result.error);
    }
  });

  socket.on('player:rollDice', ({ count, sides }) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    const safeCount = Math.min(Math.max(parseInt(count) || 1, 1), 20);
    const safeSides = Math.min(Math.max(parseInt(sides) || 100, 2), 1000);
    const result = session.engine.rollDice(socket.id, safeCount, safeSides);
    if (result.success) {
      socket.emit('player:diceResult', result);
      if (session.engine.gmSocketId) {
        io.to(session.engine.gmSocketId).emit('gm:diceResult', result);
      }
    }
  });

  socket.on('player:sendMessage', ({ text }) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    if (typeof text !== 'string' || text.trim().length === 0) return;
    const safeMessage = text.trim().slice(0, 1000);

    const result = session.engine.receivePlayerMessage(socket.id, safeMessage);
    if (result.success && session.engine.gmSocketId) {
      io.to(session.engine.gmSocketId).emit('gm:playerMessage', {
        playerSocketId: socket.id,
        playerName: result.playerName,
        message: result.message
      });
      io.to(session.engine.gmSocketId).emit('gm:state', session.engine.getGMState());
    }
  });

  socket.on('gm:reset', () => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    session.engine.resetGame();
    console.log(`[MJ] Reset — ${sessionCode}`);
    for (const [sid] of session.engine.players) {
      io.to(sid).emit('player:state', session.engine.getPlayerState(sid));
      io.to(sid).emit('player:reset');
    }
    socket.emit('gm:state', session.engine.getGMState());
  });

  socket.on('gm:requestState', () => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    socket.emit('gm:state', session.engine.getGMState());
  });

  // ─── Player Events ───────────────────────────────────
  socket.on('player:join', ({ code, name }) => {
    const upperCode = code?.toUpperCase();
    const session = sessions.get(upperCode);
    if (!session) { socket.emit('player:error', 'Session introuvable. Vérifie le code.'); return; }

    const safeName = (typeof name === 'string') ? name.trim().slice(0, 50) : 'Joueur';

    const reconnect = session.engine.reconnectPlayer(socket.id, safeName);
    if (reconnect.success) {
      sessionCode = upperCode;
      playerRole = 'player';
      socket.join(upperCode);
      socket.emit('session:info', { roleplay: session.roleplay });
      socket.emit('player:joined', { name: safeName });
      socket.emit('player:state', session.engine.getPlayerState(socket.id));
      io.to(`gm:${upperCode}`).emit('gm:state', session.engine.getGMState());
      return;
    }

    const result = session.engine.addPlayer(socket.id, safeName);
    if (result.success) {
      sessionCode = upperCode;
      playerRole = 'player';
      socket.join(upperCode);
      socket.emit('session:info', { roleplay: session.roleplay });
      socket.emit('player:joined', { name: safeName });
      socket.emit('player:state', session.engine.getPlayerState(socket.id));
      io.to(`gm:${upperCode}`).emit('gm:state', session.engine.getGMState());
      console.log(`[Joueur] ${safeName} rejoint — ${upperCode}`);
    } else {
      socket.emit('player:error', result.error);
    }
  });

  socket.on('player:flipCard', (characterId) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.flipCard(socket.id, characterId);
    if (result.success) {
      socket.emit('player:cardFlipped', result.character);
      socket.emit('player:state', session.engine.getPlayerState(socket.id));
      io.to(`gm:${sessionCode}`).emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('player:error', result.error);
    }
  });

  socket.on('player:selectCard', (characterId) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.selectCard(socket.id, characterId);
    if (result.success) {
      socket.emit('player:cardSelected', { characterId });
      broadcastPlayerStates(sessionCode);
      io.to(`gm:${sessionCode}`).emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('player:error', result.error);
    }
  });

  socket.on('player:swapCard', (targetCharacterId) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.swapCard(socket.id, targetCharacterId);
    if (result.success) {
      broadcastPlayerStates(sessionCode);
      io.to(`gm:${sessionCode}`).emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('player:error', result.error);
    }
  });

  socket.on('player:validateSelection', () => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.validateSelection(socket.id);
    if (result.success) {
      socket.emit('player:selectionValidated');
      broadcastPlayerStates(sessionCode);
      io.to(`gm:${sessionCode}`).emit('gm:state', session.engine.getGMState());
    } else {
      socket.emit('player:error', result.error);
    }
  });

  socket.on('gm:setStep', ({ index }) => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    session.engine.setCurrentStep(index);
    socket.emit('gm:state', session.engine.getGMState());
  });

  socket.on('gm:validateStep', ({ index }) => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    session.engine.validateStep(index);
    socket.emit('gm:state', session.engine.getGMState());
  });

  socket.on('gm:saveSheet', ({ playerSocketId, stats, inventory }) => {
    if (!sessionCode || !isGM(sessionCode)) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const player = session.engine.players.get(playerSocketId);
    if (!player) { socket.emit('gm:error', 'Joueur introuvable.'); return; }
    const character = session.engine.getCharacterById(player.selectedCharacter);

    const currentStats = character?.stats || {};
    const statsChanged = character && Object.keys(stats).some(k => stats[k] !== (currentStats[k] ?? 0));

    const inventoryChanged = JSON.stringify(inventory) !== JSON.stringify(player.inventory);

    if (statsChanged) character.stats = { ...currentStats, ...stats };
    if (inventoryChanged) player.inventory = inventory;

    if (statsChanged) io.to(playerSocketId).emit('player:statsUpdated');
    if (inventoryChanged) io.to(playerSocketId).emit('player:inventoryUpdated');

    if (statsChanged || inventoryChanged) {
      io.to(playerSocketId).emit('player:state', session.engine.getPlayerState(playerSocketId));
      socket.emit('gm:state', session.engine.getGMState());
    }
  });

  socket.on('player:requestState', () => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    socket.emit('player:state', session.engine.getPlayerState(socket.id));
  });

  // ─── Disconnect ──────────────────────────────────────
  socket.on('disconnect', () => {
    if (!sessionCode || playerRole !== 'player') return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    session.engine.removePlayer(socket.id);
    io.to(`gm:${sessionCode}`).emit('gm:state', session.engine.getGMState());
  });
});

// ─── Start ───────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
    }
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║          🎭  ROLEMASTER  🎭                  ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Dashboard: http://${localIP}:${PORT}/`);
  console.log(`║  Local:     http://localhost:${PORT}/`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
