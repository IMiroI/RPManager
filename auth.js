// ============================================
// auth.js — Authentification via SSO VGAMES
// ============================================
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  next();
}

// Vérifie le cookie `jwt` posé par VGAMES (même SECRET_KEY, contrat HS256
// { id, username }) — ne touche jamais à la session, juste une lecture.
function readVgamesProfile(req) {
  const token = req.cookies && req.cookies.jwt;
  const secret = process.env.SECRET_KEY;
  if (!token) {
    console.log('[vgames-sso] pas de cookie jwt reçu');
    return null;
  }
  if (!secret) {
    console.error('[vgames-sso] SECRET_KEY manquante côté RoleMaster');
    return null;
  }
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload.id !== 'string' || typeof payload.username !== 'string') {
      console.error('[vgames-sso] payload JWT valide mais forme inattendue:', payload);
      return null;
    }
    return payload;
  } catch (err) {
    console.error('[vgames-sso] échec de vérification du JWT:', err.message);
    return null;
  }
}

function sanitizeUsername(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

async function uniqueUsernameFrom(candidate, fallbackId) {
  let base = sanitizeUsername(candidate);
  if (base.length < 3) base = `joueur-${fallbackId.slice(-6)}`;
  let username = base;
  let suffix = 0;
  // eslint-disable-next-line no-await-in-loop
  while (await User.findOne({ username })) {
    suffix += 1;
    username = `${base}-${suffix}`.slice(0, 30);
  }
  return username;
}

// État SSO courant, sans effet de bord — alimente la page de login pour
// choisir entre "créer un compte" et "lier un compte existant".
router.get('/vgames-status', async (req, res) => {
  const vgamesUrl = process.env.VGAMES_URL || 'http://localhost:3000';
  const profile = readVgamesProfile(req);
  if (!profile) return res.json({ vgamesAuthenticated: false, vgamesUrl });

  const linked = await User.findOne({ vgamesId: profile.id });
  res.json({
    vgamesAuthenticated: true,
    linked: !!linked,
    suggestedUsername: linked ? linked.username : sanitizeUsername(profile.username),
    vgamesUrl,
  });
});

// Crée (ou retrouve) le compte RoleMaster "miroir" lié à l'utilisateur VGAMES courant.
router.post('/vgames-provision', async (req, res) => {
  const profile = readVgamesProfile(req);
  if (!profile) return res.status(401).json({ error: 'Cookie VGAMES absent ou invalide' });

  const existing = await User.findOne({ vgamesId: profile.id });
  if (existing) {
    req.session.userId = existing._id.toString();
    req.session.username = existing.username;
    return res.json({ username: existing.username });
  }

  const username = await uniqueUsernameFrom(profile.username, profile.id);
  const user = await User.create({ username, vgamesId: profile.id });

  req.session.userId = user._id.toString();
  req.session.username = user.username;
  res.status(201).json({ username: user.username });
});

// Lie un compte RoleMaster existant (ancien username/mot de passe) au compte
// VGAMES courant — les Roleplay/AdventureCharacter existants restent intacts
// puisque User._id ne change pas.
router.post('/link-legacy', async (req, res) => {
  const profile = readVgamesProfile(req);
  if (!profile) return res.status(401).json({ error: 'Cookie VGAMES absent ou invalide' });

  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Identifiants invalides.' });
  }

  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects.' });

  if (user.vgamesId && user.vgamesId !== profile.id) {
    return res.status(409).json({ error: 'Ce compte est déjà lié à un autre compte VGAMES.' });
  }

  user.vgamesId = profile.id;
  await user.save();

  req.session.userId = user._id.toString();
  req.session.username = user.username;
  res.json({ username: user.username });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  res.json({ username: req.session.username });
});

module.exports = { router, requireAuth, readVgamesProfile };
