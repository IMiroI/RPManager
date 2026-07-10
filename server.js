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
const cookieParser = require('cookie-parser');
const { MongoStore } = require('connect-mongo');
const { GameEngine } = require('./gameEngine');
const rp = require('./roleplaysManager');
const { connectDB, MONGODB_URI } = require('./db');
const User = require('./models/User');
const { router: authRouter, requireAuth, readVgamesProfile } = require('./auth');
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
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes' },
}));
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

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

// Reconnecte silencieusement une session RoleMaster à partir du cookie VGAMES,
// seulement si un compte est déjà lié (vgamesId) — ne crée jamais de compte ici,
// pour laisser à un utilisateur avec un ancien compte la chance de le lier
// via "Lier mon compte VGAMES" plutôt que de se retrouver avec un compte miroir
// tout neuf créé silencieusement à sa première visite (voir auth.js).
async function syncVgamesSession(req, res, next) {
  if (req.session.userId) return next();
  const profile = readVgamesProfile(req);
  if (!profile) return next();
  try {
    const linked = await User.findOne({ vgamesId: profile.id });
    if (linked) {
      req.session.userId = linked._id.toString();
      req.session.username = linked.username;
    }
  } catch (e) {
    console.error('Erreur syncVgamesSession:', e);
  }
  next();
}
app.use(syncVgamesSession);

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
// Plus d'inscription locale — tous les nouveaux comptes passent par VGAMES.
app.get('/register', (req, res) => res.redirect(`${process.env.VGAMES_URL || 'http://localhost:3000'}/signup`));
app.get('/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
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
  if (roleplayDoc) await roleplayDoc.populate('members', 'username');
  const seance = adventureEngine.getSeance(roleplayId);
  const characters = await AdventureCharacter.find({ roleplay: roleplayId }).populate('player', 'username');
  const tokenPositions = seance?.nowShowing ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
  const fog = seance?.nowShowing ? await adv.getFog(roleplayId, seance.nowShowing.mediaId) : null;
  return {
    roleplay: roleplayDoc ? { id: roleplayDoc._id.toString(), name: roleplayDoc.name, themeColor: roleplayDoc.themeColor, statDefinitions: roleplayDoc.statDefinitions, statModifiersEnabled: roleplayDoc.statModifiersEnabled, gridSize: roleplayDoc.gridSize } : null,
    chapters: roleplayDoc?.chapters || [],
    npcs: roleplayDoc?.npcs || [],
    // Membres ayant résolu le lien d'invitation (avec ou sans personnage) — sert au MJ pour
    // attribuer un PNJ à l'un d'eux.
    members: roleplayDoc ? roleplayDoc.members.map(m => ({ id: m._id.toString(), username: m.username })) : [],
    isLive: !!seance,
    connectedPlayers: seance ? [...seance.connectedPlayers.values()] : [],
    nowShowing: seance?.nowShowing || null,
    mapVisible: seance?.mapVisible || false,
    nowPlaying: seance?.nowPlaying || null,
    tokenPositions,
    fog,
    initiative: seance?.initiative || null,
    journal: seance?.journal || [], // le MJ voit tout, y compris les jets de compétence PNJ cachés
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
    if (info.characters?.some(c => c.id === character.id)) {
      io.to(socketId).emit('adv:player:characterUpdated', character);
    }
  }
}

// Message privé d'un joueur vers le MJ (seul canal privé restant : "/mp message" dans le chat
// de groupe). Persisté comme avant (AdventureCharacter.messages) pour l'historique, et incrusté
// comme entrée de journal 'private' — visible uniquement du MJ et de ce joueur (jamais des autres
// joueurs), affichée avec le préfixe "MP" et le token de son auteur.
async function sendPrivateJournalMessage(roleplayId, characterId, text) {
  const character = await adv.appendPrivateMessage(roleplayId, characterId, text, 'player');
  if (!character) return null;
  const msg = character.messages[character.messages.length - 1];
  const seance = adventureEngine.getSeance(roleplayId);

  if (seance) {
    const entry = adventureEngine.addJournalEntry(seance, {
      kind: 'chat', visibility: 'private', counterpartCharacterId: characterId, mp: true, text,
      authorName: character.name, authorIcon: character.icon || '', authorTokenMediaId: character.tokenMediaId || null
    });
    io.to(`adv-gm:${roleplayId}`).emit('adv:journal:entry', entry);
    for (const [socketId, info] of seance.connectedPlayers) {
      if (info.characters?.some(c => c.id === characterId)) { io.to(socketId).emit('adv:journal:entry', entry); break; }
    }
  }

  io.to(`adv-gm:${roleplayId}`).emit('adv:gm:playerMessage', { characterId, name: character.name, message: msg });
  io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));

  return { character, msg };
}

// Message privé du MJ vers un joueur précis (symétrique de sendPrivateJournalMessage ci-dessus) —
// même persistance (AdventureCharacter.messages, from:'gm') et même entrée de journal 'private',
// visible uniquement du MJ et du joueur ciblé.
async function sendGmPrivateMessage(roleplayId, characterId, text) {
  const character = await adv.appendPrivateMessage(roleplayId, characterId, text, 'gm');
  if (!character) return null;
  const msg = character.messages[character.messages.length - 1];
  const seance = adventureEngine.getSeance(roleplayId);

  if (seance) {
    const entry = adventureEngine.addJournalEntry(seance, {
      kind: 'chat', visibility: 'private', counterpartCharacterId: characterId, mp: true, text,
      authorName: 'MJ', authorIcon: '🎭', authorTokenMediaId: null
    });
    io.to(`adv-gm:${roleplayId}`).emit('adv:journal:entry', entry);
    for (const [socketId, info] of seance.connectedPlayers) {
      if (info.characters?.some(c => c.id === characterId)) {
        io.to(socketId).emit('adv:journal:entry', entry);
        io.to(socketId).emit('adv:player:gmMessage', { characterId, message: msg });
        break;
      }
    }
  }

  return { character, msg };
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
  let advCharacterIds = new Set(); // un joueur peut jouer plusieurs personnages simultanément sur une même aventure

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

  // Changer de carte repart TOUJOURS en préparation (pas visible des joueurs) : le MJ a ainsi le
  // temps de placer tokens/sprites et de peindre le brouillard avant de révéler la scène via
  // adv:gm:setMapVisible. Les joueurs qui regardaient la carte précédente la voient se masquer.
  socket.on('adv:gm:showMedia', async ({ roleplayId, mediaId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    seance.nowShowing = { mediaId };
    seance.mapVisible = false;
    io.to(`adv-players:${roleplayId}`).emit('adv:player:mapHidden');
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  // Bascule la visibilité de la carte actuellement affichée pour les joueurs — indépendante du
  // brouillard (qui reste appliqué normalement une fois la carte révélée).
  socket.on('adv:gm:setMapVisible', async ({ roleplayId, visible }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    seance.mapVisible = !!visible;
    if (seance.mapVisible) {
      const mediaId = seance.nowShowing.mediaId;
      const tokenPositions = await adv.getMapTokenPositions(roleplayId, mediaId);
      const partyMembers = await adv.listPartyMembers(roleplayId);
      const npcRoster = await adv.listNpcRoster(roleplayId);
      const fog = await adv.getFog(roleplayId, mediaId);
      io.to(`adv-players:${roleplayId}`).emit('adv:player:nowShowing', {
        mediaId, url: `/api/adventures/${roleplayId}/media/${mediaId}/file`, tokenPositions, partyMembers, npcRoster, fog
      });
    } else {
      io.to(`adv-players:${roleplayId}`).emit('adv:player:mapHidden');
    }
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

  socket.on('adv:gm:updateCharacterStats', async ({ roleplayId, characterId, stats, statModifiers }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.updateCharacterStatsById(roleplayId, characterId, stats || {}, statModifiers);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  // Statistiques d'un PNJ modifiables en pleine séance depuis sa fiche détail (lecture réservée au
  // MJ — les PNJ n'ont pas de fiche côté joueur, rien à diffuser aux joueurs ici).
  socket.on('adv:gm:updateNpcStats', async ({ roleplayId, npcId, stats, statModifiers }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const npc = await adv.updateNpcStatsById(roleplayId, getAdvUserId(), npcId, stats || {}, statModifiers);
    if (!npc) return;
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:updateCharacterInventory', async ({ roleplayId, characterId, inventory }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.updateCharacterInventoryById(roleplayId, characterId, inventory);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  // Document texte déposé dans l'inventaire d'un personnage — le fichier est déjà en médiathèque
  // (upload REST préalable via POST .../media/document), ceci ne fait qu'y attacher une référence.
  socket.on('adv:gm:addInventoryDocument', async ({ roleplayId, characterId, mediaId, name }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    if (!mediaId) return;
    const character = await adv.addInventoryDocument(roleplayId, characterId, mediaId, name);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:removeInventoryDocument', async ({ roleplayId, characterId, docId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const character = await adv.removeInventoryDocument(roleplayId, characterId, docId);
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

  // Marqueur KO/mort sur un token (croix rouge) — bascule en un clic, réservé au MJ, visible en
  // direct par tout le monde (comme la couleur du contour du token).
  socket.on('adv:gm:setKo', async ({ roleplayId, characterId, kind, ko }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const ownerId = getAdvUserId();
    const isNpc = kind === 'npc';
    const entity = isNpc
      ? await adv.setNpcKo(roleplayId, ownerId, characterId, ko)
      : await adv.setCharacterKo(roleplayId, ownerId, characterId, ko);
    if (!entity) return;
    if (!isNpc) notifyAdventureCharacterUpdate(roleplayId, entity);
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:entity:ko', {
      characterId, kind: isNpc ? 'npc' : 'character', ko: !!entity.ko
    });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  // Attribue un PNJ à un joueur : le PNJ devient un personnage jouable par lui (ex: un allié
  // rencontré en jeu rejoint le groupe). Le joueur ciblé doit être membre de l'aventure (avoir
  // résolu le lien d'invitation) — avec ou sans personnage déjà créé.
  socket.on('adv:gm:convertNpcToCharacter', async ({ roleplayId, npcId, playerId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const result = await adv.convertNpcToCharacter(roleplayId, getAdvUserId(), npcId, playerId);
    if (!result || result.error) return;
    const { character, npcId: removedNpcId, npcName } = result;

    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:token:removed', { characterId: removedNpcId, kind: 'npc' });

    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) {
      for (const [socketId, info] of seance.connectedPlayers) {
        if (info.userId === playerId) {
          io.to(socketId).emit('adv:player:npcAssigned', { character, npcName });
          break;
        }
      }
    }
  });

  // `documentMediaId`/`documentName` facultatifs : le fichier est déjà en médiathèque (upload REST
  // préalable via POST .../media/document) — une entrée peut porter un texte, un document, ou les
  // deux, mais jamais ni l'un ni l'autre.
  socket.on('adv:gm:addJournalEntry', async ({ roleplayId, characterId, text, documentMediaId, documentName }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const safeText = typeof text === 'string' ? text.trim().slice(0, 1000) : '';
    if (!safeText && !documentMediaId) return;
    const character = await adv.appendJournalEntry(roleplayId, characterId, safeText, 'gm', documentMediaId, documentName);
    if (!character) return;
    notifyAdventureCharacterUpdate(roleplayId, character);
    socket.emit('adv:gm:state', await buildAdventureGmState(roleplayId));
  });

  socket.on('adv:gm:rollDice', ({ roleplayId, count, sides }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const result = adventureEngine.rollDice(count, sides);
    socket.emit('adv:gm:diceResult', result); // toast local MJ ; les joueurs voient le résultat via adv:journal:entry ci-dessous

    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) {
      const entry = adventureEngine.addJournalEntry(seance, {
        kind: 'dice', visibility: 'public',
        authorName: 'MJ', authorIcon: '🎭', authorTokenMediaId: null,
        count: result.count, sides: result.sides, rolls: result.rolls, total: result.total
      });
      io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:journal:entry', entry);
    }
  });

  // ─── Journal de groupe : chat visible par le MJ et tous les joueurs connectés ───
  // Un joueur pouvant contrôler plusieurs personnages simultanément, il précise avec lequel il
  // parle (characterId) — le message est attribué à ce personnage-là (nom/token affichés).
  socket.on('adv:chat:send', async ({ roleplayId, text, characterId }) => {
    if (!advRole || advRoleplayId !== roleplayId) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const safeText = text.trim().slice(0, 500);
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;

    if (advRole === 'player' && !advCharacterIds.has(characterId)) return;

    // "/mp message" depuis le chat global : envoie un message privé au MJ au lieu de le diffuser
    // à tout le monde — incrusté dans le journal (préfixe "MP"), visible seulement du MJ et de soi.
    if (advRole === 'player') {
      const mpMatch = /^\/mp\s+(.+)$/i.exec(safeText);
      if (mpMatch) {
        const mpText = mpMatch[1].trim().slice(0, 500);
        if (mpText) await sendPrivateJournalMessage(roleplayId, characterId, mpText);
        return;
      }
    }

    // "/mp NomDuJoueur message" depuis le chat global côté MJ : envoie un message privé à ce
    // joueur (résolu par pseudo de compte, pas nom de personnage — un joueur peut renommer son
    // personnage sans casser la commande) au lieu de le diffuser à tout le groupe.
    if (advRole === 'gm') {
      const mpMatch = /^\/mp\s+(\S+)\s+(.+)$/i.exec(safeText);
      if (mpMatch) {
        const [, targetUsername, rawMpText] = mpMatch;
        const target = await adv.findCharacterByPlayerUsername(roleplayId, targetUsername);
        if (!target) { socket.emit('adv:error', `Aucun personnage trouvé pour le joueur "${targetUsername}".`); return; }
        const mpText = rawMpText.trim().slice(0, 500);
        if (mpText) await sendGmPrivateMessage(roleplayId, target.id, mpText);
        return;
      }
    }

    const author = advRole === 'gm'
      ? { authorName: 'MJ', authorIcon: '🎭', authorTokenMediaId: null }
      : (() => {
        const info = seance.connectedPlayers.get(socket.id);
        const c = info?.characters.find(ch => ch.id === characterId);
        return { authorName: c?.name || 'Joueur', authorIcon: c?.icon || '', authorTokenMediaId: c?.tokenMediaId || null };
      })();

    const entry = adventureEngine.addJournalEntry(seance, { kind: 'chat', visibility: 'public', text: safeText, ...author });
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:journal:entry', entry);
  });

  // ─── Joueur ──────────────────────────────────────────
  // Un joueur peut avoir plusieurs personnages sur une même aventure et les jouer simultanément :
  // un seul join charge la liste complète, le client choisit ensuite lequel anime/parle/lance.
  // Un joueur peut rejoindre la séance sans encore avoir de personnage — utile la première fois
  // (il choisit ensuite d'en créer un, ou attend que le MJ lui en attribue un via un PNJ).
  socket.on('adv:player:join', async ({ roleplayId }) => {
    const userId = getAdvUserId();
    if (!userId) return socket.emit('adv:error', 'Non authentifié');
    const characters = await adv.listCharactersForPlayer(roleplayId, userId);
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return socket.emit('adv:error', 'Aucune séance en cours');

    advRoleplayId = roleplayId;
    advRole = 'player';
    advCharacterIds = new Set(characters.map(c => c.id));
    socket.join(`adv-players:${roleplayId}`);
    seance.connectedPlayers.set(socket.id, {
      userId,
      characters: characters.map(c => ({ id: c.id, name: c.name, icon: c.icon, tokenMediaId: c.tokenMediaId }))
    });

    const roleplayDoc = await Roleplay.findById(roleplayId);
    const chapter = (roleplayDoc?.chapters || []).find(c => c.id === seance.currentChapterId)
      || (roleplayDoc?.chapters || []).find(c => c.isCurrent);
    // Tant que le MJ n'a pas révélé la carte (mapVisible), le joueur ne reçoit ni son image, ni les
    // positions de tokens, ni l'état du brouillard — le temps que le MJ prépare la scène.
    const mapVisible = !!seance.mapVisible;
    const hasMap = mapVisible && seance.nowShowing;
    const tokenPositions = hasMap ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
    const partyMembers = await adv.listPartyMembers(roleplayId);
    const npcRoster = await adv.listNpcRoster(roleplayId);
    const fog = hasMap ? await adv.getFog(roleplayId, seance.nowShowing.mediaId) : null;
    const nowShowing = hasMap
      ? { mediaId: seance.nowShowing.mediaId, url: `/api/adventures/${roleplayId}/media/${seance.nowShowing.mediaId}/file` }
      : null;

    socket.emit('adv:player:state', {
      characters,
      chapterTitle: chapter?.title || null,
      mapVisible,
      nowShowing,
      nowPlaying: seance.nowPlaying,
      tokenPositions,
      partyMembers,
      npcRoster,
      fog,
      gridSize: roleplayDoc?.gridSize || 20,
      initiative: seance.initiative,
      journal: (seance.journal || []).filter(e => e.visibility === 'public' || (e.visibility === 'private' && advCharacterIds.has(e.counterpartCharacterId))),
      connectedCount: seance.connectedPlayers.size
    });

    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:playerJoined', { names: characters.map(c => c.name) });
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:state', await buildAdventureGmState(roleplayId));
    io.to(`adv-players:${roleplayId}`).emit('adv:player:connectedCount', { count: seance.connectedPlayers.size });
  });

  socket.on('adv:player:rollDice', ({ roleplayId, count, sides, characterId }) => {
    if (advRole !== 'player' || advRoleplayId !== roleplayId) return;
    if (!advCharacterIds.has(characterId)) return;
    const result = adventureEngine.rollDice(count, sides);
    io.to(`adv-gm:${roleplayId}`).emit('adv:gm:diceResult', result); // le joueur voit son propre résultat via adv:journal:entry ci-dessous

    const seance = adventureEngine.getSeance(roleplayId);
    if (seance) {
      const info = seance.connectedPlayers.get(socket.id);
      const c = info?.characters.find(ch => ch.id === characterId);
      const entry = adventureEngine.addJournalEntry(seance, {
        kind: 'dice', visibility: 'public',
        authorName: c?.name || 'Joueur', authorIcon: c?.icon || '', authorTokenMediaId: c?.tokenMediaId || null,
        count: result.count, sides: result.sides, rolls: result.rolls, total: result.total
      });
      io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:journal:entry', entry);
    }
  });

  // ─── Jet de compétence (1d100 + 1d(taille définie sur la compétence)) ───
  // Autorisation : le MJ peut lancer n'importe quelle compétence (personnage ou PNJ),
  // le joueur uniquement les siennes — jamais celles d'un PNJ.
  socket.on('adv:skill:roll', async ({ roleplayId, characterId, kind, skillId }) => {
    const isGm = advRole === 'gm' && advRoleplayId === roleplayId;
    const isOwner = advRole === 'player' && advRoleplayId === roleplayId && advCharacterIds.has(characterId);

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

      const seanceNpc = adventureEngine.getSeance(roleplayId);
      if (seanceNpc) {
        const entry = adventureEngine.addJournalEntry(seanceNpc, {
          kind: 'skill', visibility: isHidden ? 'gm' : 'public',
          authorName: npc.name, authorIcon: npc.icon || '', authorTokenMediaId: npc.tokenMediaId || null,
          skillName: skill.name, diceSides: skill.diceSides || 6, percentile, skillRoll
        });
        io.to(`adv-gm:${roleplayId}`).emit('adv:journal:entry', entry);
        if (!isHidden) io.to(`adv-players:${roleplayId}`).emit('adv:journal:entry', entry);
      }
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
          if (info.characters?.some(c => c.id === characterId)) { io.to(socketId).emit('adv:skill:result', result); break; }
        }
      }
    }

    const seanceChar = adventureEngine.getSeance(roleplayId);
    if (seanceChar) {
      const entry = adventureEngine.addJournalEntry(seanceChar, {
        kind: 'skill', visibility: 'public',
        authorName: character.name, authorIcon: character.icon || '', authorTokenMediaId: character.tokenMediaId || null,
        skillName: skill.name, diceSides: skill.diceSides || 6, percentile, skillRoll
      });
      io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:journal:entry', entry);
    }
  });

  // ─── Jet de statistique (1d100 simple, avec la valeur de la stat en note) ───
  // Permet de suivre les jets de stats précises (perception, force...) depuis la fiche en jeu, sans
  // ouvrir la fiche détail du personnage. Privé : visible du MJ et du joueur concerné uniquement —
  // jamais diffusé aux autres joueurs (évite le méta-jeu sur un jet caché du groupe).
  socket.on('adv:stat:roll', async ({ roleplayId, characterId, kind, statKey }) => {
    const isGm = advRole === 'gm' && advRoleplayId === roleplayId;
    const isOwner = advRole === 'player' && advRoleplayId === roleplayId && advCharacterIds.has(characterId);

    const roleplayDoc = await Roleplay.findById(roleplayId).select('statDefinitions statModifiersEnabled').catch(() => null);
    const statDef = roleplayDoc?.statDefinitions.find(d => d.key === statKey);
    if (!statDef) return;
    const modifiersEnabled = !!roleplayDoc.statModifiersEnabled;

    // PNJ : réservé au MJ, jamais visible des joueurs (même confidentialité que la fiche PNJ elle-même).
    if (kind === 'npc') {
      if (!isGm) return;
      const npc = await adv.getNpcById(roleplayId, characterId);
      if (!npc) return;

      const statValue = npc.stats?.[statKey] ?? 0;
      const statModifier = modifiersEnabled ? (npc.statModifiers?.[statKey] ?? 0) : 0;
      const percentile = adventureEngine.rollDice(1, 100).rolls[0];
      const total = percentile + statModifier;
      const result = { characterId, kind: 'npc', characterName: npc.name, statKey, statLabel: statDef.label, statValue, statModifier, percentile, total };
      socket.emit('adv:stat:result', result);

      const seanceNpc = adventureEngine.getSeance(roleplayId);
      if (seanceNpc) {
        const entry = adventureEngine.addJournalEntry(seanceNpc, {
          kind: 'stat', visibility: 'gm',
          authorName: npc.name, authorIcon: npc.icon || '', authorTokenMediaId: npc.tokenMediaId || null,
          statLabel: statDef.label, statValue, statModifier, percentile, total
        });
        io.to(`adv-gm:${roleplayId}`).emit('adv:journal:entry', entry);
      }
      return;
    }

    if (!isGm && !isOwner) return;

    const character = await adv.getCharacterById(roleplayId, characterId);
    if (!character) return;

    const statValue = character.stats?.[statKey] ?? 0;
    const statModifier = modifiersEnabled ? (character.statModifiers?.[statKey] ?? 0) : 0;
    const percentile = adventureEngine.rollDice(1, 100).rolls[0];
    const total = percentile + statModifier;
    const result = { characterId, kind: 'character', characterName: character.name, statKey, statLabel: statDef.label, statValue, statModifier, percentile, total };

    socket.emit('adv:stat:result', result);
    const seance = adventureEngine.getSeance(roleplayId);
    if (isOwner) {
      io.to(`adv-gm:${roleplayId}`).emit('adv:stat:result', result);
    } else if (seance) {
      for (const [socketId, info] of seance.connectedPlayers) {
        if (info.characters?.some(c => c.id === characterId)) { io.to(socketId).emit('adv:stat:result', result); break; }
      }
    }

    if (seance) {
      const entry = adventureEngine.addJournalEntry(seance, {
        kind: 'stat', visibility: 'private', counterpartCharacterId: characterId,
        authorName: character.name, authorIcon: character.icon || '', authorTokenMediaId: character.tokenMediaId || null,
        statLabel: statDef.label, statValue, statModifier, percentile, total
      });
      io.to(`adv-gm:${roleplayId}`).emit('adv:journal:entry', entry);
      for (const [socketId, info] of seance.connectedPlayers) {
        if (info.characters?.some(c => c.id === characterId)) { io.to(socketId).emit('adv:journal:entry', entry); break; }
      }
    }
  });


  socket.on('adv:player:requestState', async ({ roleplayId }) => {
    if (advRole !== 'player' || advRoleplayId !== roleplayId) return;
    const userId = getAdvUserId();
    if (!userId) return;
    const characters = await adv.listCharactersForPlayer(roleplayId, userId);
    advCharacterIds = new Set(characters.map(c => c.id)); // reflète les personnages attribués depuis le dernier état reçu
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    const existingInfo = seance.connectedPlayers.get(socket.id);
    if (existingInfo) {
      existingInfo.characters = characters.map(c => ({ id: c.id, name: c.name, icon: c.icon, tokenMediaId: c.tokenMediaId }));
    }
    const roleplayDoc = await Roleplay.findById(roleplayId).select('gridSize');
    const mapVisible = !!seance.mapVisible;
    const hasMap = mapVisible && seance.nowShowing;
    const tokenPositions = hasMap ? await adv.getMapTokenPositions(roleplayId, seance.nowShowing.mediaId) : [];
    const partyMembers = await adv.listPartyMembers(roleplayId);
    const npcRoster = await adv.listNpcRoster(roleplayId);
    const fog = hasMap ? await adv.getFog(roleplayId, seance.nowShowing.mediaId) : null;
    socket.emit('adv:player:state', {
      characters,
      mapVisible,
      nowShowing: hasMap ? seance.nowShowing : null,
      nowPlaying: seance.nowPlaying,
      tokenPositions,
      fog,
      partyMembers,
      npcRoster,
      gridSize: roleplayDoc?.gridSize || 20,
      initiative: seance.initiative,
      journal: (seance.journal || []).filter(e => e.visibility === 'public' || (e.visibility === 'private' && advCharacterIds.has(e.counterpartCharacterId))),
      connectedCount: seance.connectedPlayers.size
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

  // ─── Suivi d'initiative (combat) — transitoire, propre à la séance en cours, contrôlé par le MJ ───
  socket.on('adv:gm:initiative:add', ({ roleplayId, kind, entityId, name, icon, tokenMediaId, tokenColor }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    if (kind !== 'character' && kind !== 'npc') return;
    if (!entityId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    if (seance.initiative.entries.some(e => e.entityId === entityId)) return; // déjà dans la liste
    adventureEngine.addInitiativeEntry(seance, {
      kind, entityId,
      name: String(name || '?').slice(0, 60),
      icon: String(icon || '').slice(0, 8),
      tokenMediaId: tokenMediaId || null,
      tokenColor: adv.sanitizeTokenColor(tokenColor)
    });
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:initiative:state', seance.initiative);
  });

  socket.on('adv:gm:initiative:setScore', ({ roleplayId, entryId, score }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    if (!adventureEngine.setInitiativeScore(seance, entryId, score)) return;
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:initiative:state', seance.initiative);
  });

  socket.on('adv:gm:initiative:remove', ({ roleplayId, entryId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    adventureEngine.removeInitiativeEntry(seance, entryId);
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:initiative:state', seance.initiative);
  });

  socket.on('adv:gm:initiative:next', ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    adventureEngine.nextInitiativeTurn(seance);
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:initiative:state', seance.initiative);
  });

  socket.on('adv:gm:initiative:reset', ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance) return;
    adventureEngine.resetInitiative(seance);
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:initiative:state', seance.initiative);
  });

  // ─── Brouillard de guerre (carte actuellement affichée) — grille FIXE, propre au brouillard et
  // indépendante de la grille tactique des tokens (voir FOG_GRID_COLUMNS côté client). Masque des
  // zones que les joueurs découvrent en s'approchant ou que le MJ révèle/masque manuellement ; côté
  // joueur, une case non révélée masque aussi le décor/PNJ/tokens des autres joueurs qui s'y
  // trouvent (jamais les siens). Le MJ voit toujours la carte et tous les tokens dans son panneau.
  socket.on('adv:gm:fog:setEnabled', async ({ roleplayId, enabled }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    const fog = await adv.setFogEnabled(roleplayId, getAdvUserId(), seance.nowShowing.mediaId, enabled);
    if (!fog) return;
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:fog:state', { mediaId: seance.nowShowing.mediaId, ...fog });
  });

  socket.on('adv:gm:fog:setCells', async ({ roleplayId, cells, revealed }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    const fog = await adv.setFogCells(roleplayId, getAdvUserId(), seance.nowShowing.mediaId, cells, !!revealed);
    if (!fog) return;
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:fog:state', { mediaId: seance.nowShowing.mediaId, ...fog });
  });

  socket.on('adv:gm:fog:reset', async ({ roleplayId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    const fog = await adv.resetFog(roleplayId, getAdvUserId(), seance.nowShowing.mediaId);
    if (!fog) return;
    io.to(`adv-gm:${roleplayId}`).to(`adv-players:${roleplayId}`).emit('adv:fog:state', { mediaId: seance.nowShowing.mediaId, ...fog });
  });

  // ─── Token (déplacement sur la carte, façon Roll20) ─────────
  // Autorisation : le MJ peut déplacer n'importe quel token (PNJ ou personnage), le joueur
  // uniquement le token de l'un de ses propres personnages (il peut en jouer plusieurs) — jamais un PNJ.
  function canMoveToken(roleplayId, characterId, kind) {
    if (advRole === 'gm' && advRoleplayId === roleplayId) return true;
    if (kind === 'npc') return false;
    if (advRole === 'player' && advRoleplayId === roleplayId && advCharacterIds.has(characterId)) return true;
    return false;
  }

  socket.on('adv:token:drag', ({ roleplayId, characterId, kind, x, y }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    socket.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:position', { characterId, kind, x, y, final: false });
  });

  // Rayon (en cases de la grille FIXE du brouillard, voir FOG_GRID_COLUMNS côté client) découvert
  // autour d'un personnage qui se déplace.
  const FOG_REVEAL_RADIUS = 2;

  socket.on('adv:token:drop', async ({ roleplayId, characterId, kind, x, y, col, row }) => {
    if (!canMoveToken(roleplayId, characterId, kind)) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    await adv.setTokenPosition(roleplayId, seance.nowShowing.mediaId, characterId, x, y, kind);
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:position', { characterId, kind, x, y, final: true });

    if (kind === 'character' && Number.isInteger(col) && Number.isInteger(row)) {
      const fog = await adv.autoRevealFog(roleplayId, seance.nowShowing.mediaId, col, row, FOG_REVEAL_RADIUS);
      if (fog) io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:fog:state', { mediaId: seance.nowShowing.mediaId, ...fog });
    }
  });

  // Pose un nouveau sprite de décor sur la carte affichée (MJ uniquement) — un id d'instance est
  // généré côté serveur pour permettre de poser plusieurs fois le même sprite sur une même carte.
  socket.on('adv:sprite:place', async ({ roleplayId, spriteMediaId }) => {
    if (advRole !== 'gm' || advRoleplayId !== roleplayId) return;
    if (!spriteMediaId) return;
    const seance = adventureEngine.getSeance(roleplayId);
    if (!seance || !seance.nowShowing) return;
    const instanceId = `sprite_${randomBytes(6).toString('hex')}`;
    await adv.setTokenPosition(roleplayId, seance.nowShowing.mediaId, instanceId, 50, 50, 'sprite', spriteMediaId);
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:token:position', {
      characterId: instanceId, kind: 'sprite', spriteMediaId, x: 50, y: 50, final: true
    });
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

  // Ping visuel (clic droit sur la carte ou un token) — purement transitoire, non persisté.
  socket.on('adv:ping', ({ roleplayId, x, y, color }) => {
    if (!advRole || advRoleplayId !== roleplayId) return;
    const px = Number(x), py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const safeColor = adv.sanitizeTokenColor(color);
    io.to(`adv-players:${roleplayId}`).to(`adv-gm:${roleplayId}`).emit('adv:ping', {
      x: Math.min(100, Math.max(0, px)), y: Math.min(100, Math.max(0, py)), color: safeColor
    });
  });

  socket.on('disconnect', () => {
    if (advRole !== 'player' || !advRoleplayId) return;
    const seance = adventureEngine.getSeance(advRoleplayId);
    if (!seance) return;
    seance.connectedPlayers.delete(socket.id);
    io.to(`adv-gm:${advRoleplayId}`).emit('adv:gm:playerLeft', { characterIds: [...advCharacterIds] });
    io.to(`adv-players:${advRoleplayId}`).emit('adv:player:connectedCount', { count: seance.connectedPlayers.size });
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
