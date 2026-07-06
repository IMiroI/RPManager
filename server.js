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
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { GameEngine } = require('./gameEngine');
const rp = require('./roleplaysManager');
const { connectDB, MONGODB_URI } = require('./db');
const { router: authRouter, requireAuth } = require('./auth');
const { router: adventuresRouter } = require('./adventures');
const adv = require('./adventuresManager');
const adventureEngine = require('./adventureEngine');
const Roleplay = require('./models/Roleplay');
const AdventureCharacter = require('./models/AdventureCharacter');

const app = express();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3003').split(',');

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGINS } });

const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET manquant dans .env — arrêt.');
  process.exit(1);
}

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
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, collectionName: 'sessions' }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // cookie sécurisé uniquement si la requête arrive en HTTPS (direct ou via reverse proxy)
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
// Rend req.session disponible sur les sockets Aventure (socket.request.session) —
// les handlers gm:*/player: * existants ne le lisent jamais, comportement OneShot inchangé.
io.engine.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Auth ────────────────────────────────────────
app.use('/api/auth', authRouter);

// ─── API Aventures ───────────────────────────────────
app.use('/api/adventures', adventuresRouter);

// ─── API Roleplays ───────────────────────────────────
app.get('/api/roleplays', requireAuth, async (req, res) => {
  res.json(await rp.getAllRoleplays(req.session.userId));
});

app.get('/api/roleplays/:id', requireAuth, async (req, res) => {
  const data = await rp.getRoleplay(req.params.id, req.session.userId);
  if (!data) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

app.post('/api/roleplays', requireAuth, async (req, res) => {
  try {
    const data = await rp.createRoleplay(req.body, req.session.userId);
    res.status(201).json(data);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(400).json({ error: 'Données invalides' });
  }
});

app.put('/api/roleplays/:id', requireAuth, async (req, res) => {
  try {
    const before = await rp.getRoleplay(req.params.id, req.session.userId);
    const data = await rp.updateRoleplay(req.params.id, req.body, req.session.userId);
    if (!data) return res.status(404).json({ error: 'Introuvable' });

    if (data.type === 'aventure' && req.body.statDefinitions !== undefined) {
      await adv.syncStatDefinitions(req.params.id, before?.statDefinitions, data.statDefinitions);
    }

    res.json(data);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/roleplays/:id', requireAuth, async (req, res) => {
  for (const [, session] of sessions) {
    if (session.roleplay.id === req.params.id) {
      return res.status(409).json({ error: 'Une session est en cours pour ce roleplay.' });
    }
  }
  try {
    const ok = await rp.deleteRoleplay(req.params.id, req.session.userId);
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
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/editor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/editor/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/gm/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gm.html')));
app.get('/player/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/aventure-editor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'aventure-editor.html')));
app.get('/aventure-editor/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'aventure-editor.html')));
app.get('/adventure/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'adventure.html')));
app.get('/adventure-gm/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'adventure-gm.html')));

// ─── Aventure — helpers d'état temps réel ─────────────
async function buildAdventureGmState(roleplayId) {
  const roleplayDoc = await Roleplay.findById(roleplayId);
  const seance = adventureEngine.getSeance(roleplayId);
  const characters = await AdventureCharacter.find({ roleplay: roleplayId }).populate('player', 'username');
  const tokenPositions = seance?.nowShowing ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
  return {
    roleplay: roleplayDoc ? { id: roleplayDoc._id.toString(), name: roleplayDoc.name, themeColor: roleplayDoc.themeColor, statDefinitions: roleplayDoc.statDefinitions, gridSize: roleplayDoc.gridSize } : null,
    chapters: roleplayDoc?.chapters || [],
    npcs: roleplayDoc?.npcs || [],
    isLive: !!seance,
    connectedPlayers: seance ? [...seance.connectedPlayers.values()] : [],
    nowShowing: seance?.nowShowing || null,
    nowPlaying: seance?.nowPlaying || null,
    tokenPositions,
    characters: characters.map(c => {
      const j = c.toJSON();
      j.playerUsername = c.player?.username;
      return j;
    })
  };
}

function notifyAdventureCharacterUpdate(roleplayId, character) {
  const seance = adventureEngine.getSeance(roleplayId);
  if (!seance) return;
  for (const [socketId, info] of seance.connectedPlayers) {
    if (info.characterId === character.id) {
      io.to(socketId).emit('adv:player:characterUpdated', character);
    }
  }
}

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

  // ═══════════════════════════════════════════════════
  // ─── Aventure (temps réel) — bloc indépendant ────────
  // Variables de fermeture et disconnect propres ; ne touche jamais
  // aux handlers OneShot ci-dessus.
  // ═══════════════════════════════════════════════════
  let advRoleplayId = null;
  let advRole = null; // 'gm' | 'player'
  let advCharacterId = null;

  function getAdvUserId() {
    return socket.request.session?.userId || null;
  }

  // ─── MJ ──────────────────────────────────────────────
  socket.on('adv:gm:connect', async ({ roleplayId }) => {
    const userId = getAdvUserId();
    if (!userId) return socket.emit('adv:error', 'Non authentifié');
    const roleplayDoc = await adv.getOwnedAdventure(roleplayId, userId);
    if (!roleplayDoc) return socket.emit('adv:error', 'Accès refusé');

    advRoleplayId = roleplayId;
    advRole = 'gm';
    socket.join(`adv-gm:${roleplayId}`);

    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) seance.gmSocketId = socket.id;

    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:openSeance', async ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    adventureEngine.openSeance(roleplayId);
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-players:${roleplayId}`).emit('adv:player:seanceOpened');
  });

  socket.on('adv:gm:closeSeance', async ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    adventureEngine.closeSeance(roleplayId);
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-players:${roleplayId}`).emit('adv:player:seanceClosed');
  });

  socket.on('adv:gm:setCurrentChapter', async ({ roleplayId, chapterId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const chapters = await adv.setCurrentChapter(roleplayId, getAdvUserId(), chapterId);
    if (!chapters) return;
    const chapter = chapters.find(c => c.id === chapterId);
    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) seance.currentChapterId = chapterId;
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-players:${roleplayId}`).emit('adv:player:chapterChanged', { chapterId, title: chapter?.title });
  });

  socket.on('adv:gm:showMedia', async ({ roleplayId, mediaId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    seance.nowShowing = { mediaId };
    const tokenPositions = await adv.getMapTokenPositions(roleplayId, mediaId);
    const partyMembers = await adv.listPartyMembers(roleplayId);
    const npcRoster = await adv.listNpcRoster(roleplayId);
    io.to(`adv-players:${roleplayId}`).emit('adv:player:nowShowing', {
      mediaId, url: `/api/adventures/${roleplayId}/media/${mediaId}/file`, tokenPositions, partyMembers, npcRoster
    });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:playMusic', async ({ roleplayId, mediaId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    seance.nowPlaying = { mediaId, startedAt: Date.now(), paused: false };
    io.to(`adv-players:${roleplayId}`).emit('adv:player:nowPlaying', {
      mediaId, url: `/api/adventures/${roleplayId}/media/${mediaId}/file`, startedAt: seance.nowPlaying.startedAt
    });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:pauseMusic', async ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowPlaying) return;
    seance.nowPlaying = null;
    io.to(`adv-players:${roleplayId}`).emit('adv:player:musicPaused');
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:updateCharacterStats', async ({ roleplayId, characterId, stats }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.updateCharacterStatsById(roleplayId, characterId, stats || {});
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:updateCharacterInventory', async ({ roleplayId, characterId, inventory }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.updateCharacterInventoryById(roleplayId, characterId, inventory);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:updateCharacterSkills', async ({ roleplayId, characterId, skills }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.updateCharacterSkillsById(roleplayId, characterId, skills);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:addJournalEntry', async ({ roleplayId, characterId, text }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const character = await adv.appendJournalEntry(roleplayId, characterId, text.trim().slice(0, 1000), 'gm');
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:rollDice', ({ roleplayId, count, sides }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const result = adventureEngine.rollDice(count, sides);
    socket.emit('adv:gm:diceResult', result);
    io.to(`adv-players:${roleplayId}`).emit('adv:player:gmDiceResult', result);
  });

  socket.on('adv:gm:message', async ({ roleplayId, characterId, text }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const safeText = text.trim().slice(0, 1000);

    const character = await adv.appendPrivateMessage(roleplayId, characterId, safeText, 'gm');
    if (!character) return;
    const msg = character.messages[character.messages.length - 1];

    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) {
      for (const [socketId, info] of seance.connectedPlayers) {
        if (info.characterId === characterId) { io.to(socketId).emit('adv:player:privateMessage', msg); break; }
      }
    }
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  // ─── Joueur ──────────────────────────────────────────
  socket.on('adv:player:join', async ({ roleplayId }) => {
    const userId = getAdvUserId();
    if (!userId) return socket.emit('adv:error', 'Non authentifié');
    const character = await adv.getCharacter(roleplayId, userId);
    if (!character) return socket.emit('adv:error', 'Aucun personnage sur cette aventure');
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return socket.emit('adv:error', 'Aucune séance en cours');

    advRoleplayId = roleplayId;
    advRole = 'player';
    advCharacterId = character.id;
    socket.join(`adv-players:${roleplayId}`);
    seance.connectedPlayers.set(socket.id, { userId, characterId: character.id, name: character.name });

    const roleplayDoc = await Roleplay.findById(roleplayId);
    const chapter = (roleplayDoc?.chapters || []).find(c => c.id === seance.currentChapterId)
      || (roleplayDoc?.chapters || []).find(c => c.isCurrent);
    const tokenPositions = seance.nowShowing ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
    const partyMembers = await adv.listPartyMembers(roleplayId);
    const npcRoster = await adv.listNpcRoster(roleplayId);
    const nowShowing = seance.nowShowing
      ? { mediaId: seance.nowShowing.mediaId, url: `/api/adventures/${roleplayId}/media/${seance.nowShowing.mediaId}/file` }
      : null;

    socket.emit('adv:player:state', {
      character,
      chapterTitle: chapter?.title || null,
      nowShowing,
      nowPlaying: seance.nowPlaying,
      tokenPositions,
      partyMembers,
      npcRoster,
      gridSize: roleplayDoc?.gridSize || 20
    });

    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:playerJoined', { characterId: character.id, name: character.name });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:player:rollDice', ({ roleplayId, count, sides }) => {
    if (advRole !== 'player' || advRoleplayId !== roleplayId) return;
    const result = adventureEngine.rollDice(count, sides);
    socket.emit('adv:player:diceResult', result);
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:diceResult', result);
  });

  // ─── Jet de compétence (1d100 + 1d(taille définie sur la compétence)) ───
  // Autorisation : le MJ peut lancer n'importe quelle compétence (personnage ou PNJ),
  // le joueur uniquement les siennes — jamais celles d'un PNJ.
  socket.on('adv:skill:roll', async ({ roleplayId, characterId, kind, skillId }) => {
    const isGm = advRole === 'gm' && advRoleplayId === roleplayId;
    const isOwner = advRole === 'player' && advRoleplayId === roleplayId && advCharacterId === characterId;

    if (kind === 'npc') {
      if (!isGm) return;
      const npc = await adv.getNpcById(roleplayId, characterId);
      if (!npc) return;
      const isHidden = (npc.hiddenSkills || []).some(s => s.id === skillId);
      const skill = [...(npc.visibleSkills || []), ...(npc.hiddenSkills || [])].find(s => s.id === skillId);
      if (!skill) return;

      const percentile = adventureEngine.rollDice(1, 100).rolls[0];
      const skillRoll = adventureEngine.rollDice(1, skill.diceSides || 6).rolls[0];
      const result = {
        characterId, kind: 'npc', characterName: npc.name,
        skillId, skillName: skill.name, diceSides: skill.diceSides || 6,
        percentile, skillRoll
      };
      socket.emit('adv:skill:result', result);
      if (!isHidden) socket.to(`adv-players:${roleplayId}`).emit('adv:skill:result', result);
      return;
    }

    if (!isGm && !isOwner) return;

    const character = await adv.getCharacterById(roleplayId, characterId);
    if (!character) return;
    const skill = (character.skills || []).find(s => s.id === skillId);
    if (!skill) return;

    const percentile = adventureEngine.rollDice(1, 100).rolls[0];
    const skillRoll = adventureEngine.rollDice(1, skill.diceSides || 6).rolls[0];
    const result = {
      characterId, kind: 'character', characterName: character.name,
      skillId, skillName: skill.name, diceSides: skill.diceSides || 6,
      percentile, skillRoll
    };

    socket.emit('adv:skill:result', result);
    if (isOwner) {
      io.to(`adv-gm:${roleplayId}`).emit('adv:skill:result', result);
    } else {
      const seance = adventureEngine.getSeance(roleplayId);
      if (seance) {
        for (const [socketId, info] of seance.connectedPlayers) {
          if (info.characterId === characterId) { io.to(socketId).emit('adv:skill:result', result); break; }
        }
      }
    }
  });

  socket.on('adv:player:sendMessage', async ({ roleplayId, text }) => {
    if (advRole !== 'player' || advRoleplayId !== roleplayId) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const safeText = text.trim().slice(0, 1000);

    const character = await adv.appendPrivateMessage(roleplayId, advCharacterId, safeText, 'player');
    if (!character) return;
    const msg = character.messages[character.messages.length - 1];

    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:playerMessage', { characterId: advCharacterId, name: character.name, message: msg });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:player:requestState', async ({ roleplayId }) => {
    if (advRole !== 'player' || advRoleplayId !== roleplayId) return;
    const character = await adv.getCharacterById(roleplayId, advCharacterId);
    const seance = adventureEngine.getSeance(roleplayId);
    if (!character || !seance) return;
    const roleplayDoc = await Roleplay.findById(roleplayId).select('gridSize');
    const tokenPositions = seance.nowShowing ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
    const partyMembers = await adv.listPartyMembers(roleplayId);
    const npcRoster = await adv.listNpcRoster(roleplayId);
    socket.emit('adv:player:state', {
      character,
      nowShowing: seance.nowShowing,
      nowPlaying: seance.nowPlaying,
      tokenPositions,
      partyMembers,
      npcRoster,
      gridSize: roleplayDoc?.gridSize || 20
    });
  });

  // Taille de la grille tactique (nombre de colonnes) — réglée par le MJ, diffusée en direct.
  socket.on('adv:gm:setGridSize', async ({ roleplayId, gridSize }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const value = await adv.setGridSize(roleplayId, getAdvUserId(), gridSize);
    if (value === null) return;
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-players:${roleplayId}`).emit('adv:player:gridSize', { gridSize: value });
  });

  // ─── Token (déplacement sur la carte, façon Roll20) ─────────
  // Autorisation : le MJ peut déplacer n'importe quel token (PNJ ou personnage),
  // le joueur uniquement le token de son propre personnage — jamais un PNJ.
  function canMoveToken(roleplayId, characterId, kind) {
    if (advRole === 'gm' && advRoleplayId === roleplayId) return true;
    if (kind === 'npc') return false;
    if (advRole === 'player' && advRoleplayId === roleplayId && advCharacterId === characterId) return true;
    return false;
  }

  socket.on('adv:token:drag', ({ roleplayId, characterId, kind, x, y }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    socket.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:position', { characterId, kind, x, y, final: false });
  });

  socket.on('adv:token:drop', async ({ roleplayId, characterId, kind, x, y }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    await adv.setTokenPosition(roleplayId, seance.nowShowing.mediaId, characterId, x, y, kind);
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:position', { characterId, kind, x, y, final: true });
  });

  // Rotation discrète du token (touches Ctrl + flèches côté client)
  socket.on('adv:token:rotate', async ({ roleplayId, characterId, kind, rotation }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    const positions = await adv.setTokenRotation(roleplayId, seance.nowShowing.mediaId, characterId, rotation);
    if (!positions) return;
    const safeRotation = ((Number(rotation) || 0) % 360 + 360) % 360;
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:rotated', { characterId, kind, rotation: safeRotation });
  });

  // Retrait du token de la carte (touche Suppr côté client)
  socket.on('adv:token:remove', async ({ roleplayId, characterId, kind }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    await adv.removeTokenPosition(roleplayId, seance.nowShowing.mediaId, characterId);
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:removed', { characterId, kind });
  });

  socket.on('disconnect', () => {
    if (advRole !== 'player' || !advRoleplayId) return;
    const seance = adventureEngine.getSeance(advRoleplayId);
    if (!seance) return;
    seance.connectedPlayers.delete(socket.id);
    io.to(`adv-gm:${advRoleplayId}`).emit('adv:gm:playerLeft', { characterId: advCharacterId });
  });
});

// ─── Start ───────────────────────────────────────────
connectDB().then(() => {
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
}).catch(err => {
  console.error('[DB] Connexion échouée:', err);
  process.exit(1);
});
