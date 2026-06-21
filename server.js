// ============================================
// server.js — RPManager — Serveur principal
// ============================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const { GameEngine } = require('./gameEngine');
const rp = require('./roleplaysManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3001;

// Active sessions: code -> { engine, roleplay }
const sessions = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return sessions.has(code) ? generateCode() : code;
}

// ─── Middleware ──────────────────────────────────────
app.use(express.json());
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
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/roleplays/:id', (req, res) => {
  const data = rp.updateRoleplay(req.params.id, req.body);
  if (!data) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

app.delete('/api/roleplays/:id', (req, res) => {
  // Refuse if active sessions exist for this roleplay
  for (const [, session] of sessions) {
    if (session.roleplay.id === req.params.id) {
      return res.status(409).json({ error: 'Une session est en cours pour ce roleplay.' });
    }
  }
  const ok = rp.deleteRoleplay(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Introuvable' });
  res.json({ success: true });
});

// ─── API Sessions ────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const roleplay = req.body.roleplay;
  if (!roleplay || !roleplay.name) {
    return res.status(400).json({ error: 'Données du roleplay invalides.' });
  }
  if (!roleplay.characters?.length) {
    return res.status(400).json({ error: 'Ce roleplay n\'a aucun personnage.' });
  }

  const code = generateCode();
  sessions.set(code, { engine: new GameEngine(roleplay), roleplay });

  res.json({
    code,
    roleplay: { id: roleplay.id, name: roleplay.name, themeColor: roleplay.themeColor }
  });
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
  const code = req.params.code.toUpperCase();
  if (!sessions.has(code)) return res.status(404).json({ error: 'Session introuvable' });
  sessions.delete(code);
  res.json({ success: true });
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

  // ─── GM Events ──────────────────────────────────────
  socket.on('gm:connect', ({ code }) => {
    const session = sessions.get(code);
    if (!session) { socket.emit('error:session', 'Session introuvable'); return; }

    sessionCode = code;
    playerRole = 'gm';
    session.engine.setGM(socket.id);
    socket.join(`gm:${code}`);
    socket.emit('session:info', { roleplay: session.roleplay });
    socket.emit('gm:state', session.engine.getGMState());
    console.log(`[MJ] Connecté — Session: ${code}`);
  });

  socket.on('gm:distribute', () => {
    if (!sessionCode) return;
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
    if (!sessionCode) return;
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
    if (!sessionCode) return;
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
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const result = session.engine.sendPrivateMessage(playerSocketId, message);
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

    const result = session.engine.receivePlayerMessage(socket.id, text);
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
    if (!sessionCode) return;
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
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    socket.emit('gm:state', session.engine.getGMState());
  });

  // ─── Player Events ───────────────────────────────────
  socket.on('player:join', ({ code, name }) => {
    const upperCode = code?.toUpperCase();
    const session = sessions.get(upperCode);
    if (!session) { socket.emit('player:error', 'Session introuvable. Vérifie le code.'); return; }

    const reconnect = session.engine.reconnectPlayer(socket.id, name);
    if (reconnect.success) {
      sessionCode = upperCode;
      playerRole = 'player';
      socket.join(upperCode);
      socket.emit('session:info', { roleplay: session.roleplay });
      socket.emit('player:joined', { name });
      socket.emit('player:state', session.engine.getPlayerState(socket.id));
      io.to(`gm:${upperCode}`).emit('gm:state', session.engine.getGMState());
      return;
    }

    const result = session.engine.addPlayer(socket.id, name);
    if (result.success) {
      sessionCode = upperCode;
      playerRole = 'player';
      socket.join(upperCode);
      socket.emit('session:info', { roleplay: session.roleplay });
      socket.emit('player:joined', { name });
      socket.emit('player:state', session.engine.getPlayerState(socket.id));
      io.to(`gm:${upperCode}`).emit('gm:state', session.engine.getGMState());
      console.log(`[Joueur] ${name} rejoint — ${upperCode}`);
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
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    session.engine.setCurrentStep(index);
    socket.emit('gm:state', session.engine.getGMState());
  });

  socket.on('gm:validateStep', ({ index }) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    session.engine.validateStep(index);
    socket.emit('gm:state', session.engine.getGMState());
  });

  socket.on('gm:saveSheet', ({ playerSocketId, stats, inventory }) => {
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const player = session.engine.players.get(playerSocketId);
    if (!player) { socket.emit('gm:error', 'Joueur introuvable.'); return; }
    const character = session.engine.getCharacterById(player.selectedCharacter);

    // Compare stats avec les valeurs actuelles
    const currentStats = character?.stats || {};
    const statsChanged = character && Object.keys(stats).some(k => stats[k] !== (currentStats[k] ?? 0));

    // Compare inventaire avec la valeur actuelle
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
