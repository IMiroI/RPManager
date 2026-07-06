// ============================================
// auth.js — Routes d'authentification
// ============================================
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  next();
}

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Nom d\'utilisateur invalide (3-30 caractères, lettres/chiffres/-/_).' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'Ce nom d\'utilisateur est déjà pris.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ username: username.toLowerCase(), passwordHash });

    req.session.userId = user._id.toString();
    req.session.username = user.username;
    res.status(201).json({ username: user.username });
  } catch (e) {
    console.error('Erreur register:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Identifiants invalides.' });
    }

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects.' });

    req.session.userId = user._id.toString();
    req.session.username = user.username;
    res.json({ username: user.username });
  } catch (e) {
    console.error('Erreur login:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
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

module.exports = { router, requireAuth };
