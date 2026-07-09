// ============================================
// adventures.js — Routes API pour les roleplays de type "aventure"
// ============================================
const express = require('express');
const path = require('path');
const { requireAuth } = require('./auth');
const adv = require('./adventuresManager');
const { uploadMap, uploadMusic, uploadToken, uploadSprite, uploadDocument, UPLOAD_ROOT } = require('./uploadStorage');
const adventureEngine = require('./adventureEngine');

const router = express.Router();

// Enveloppe une middleware multer pour renvoyer une erreur JSON 400 (fichier trop gros/type refusé)
// plutôt que de laisser Express planter sur l'erreur brute.
function handleUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Fichier invalide' });
      next();
    });
  };
}

// ─── Résolution par code d'invitation ───────────────
router.get('/by-code/:code', requireAuth, async (req, res) => {
  const data = await adv.resolveByInviteCode(req.params.code.toUpperCase(), req.session.userId);
  if (!data) return res.status(404).json({ error: 'Aventure introuvable' });
  res.json(data);
});

// ─── Gestion de mes personnages (tableau de bord, toutes aventures confondues) ───
router.get('/my-characters', requireAuth, async (req, res) => {
  res.json(await adv.listCharactersAcrossAdventures(req.session.userId));
});

// ─── État de la séance en direct ─────────────────────
router.get('/:id/live-status', requireAuth, async (req, res) => {
  const seance = adventureEngine.getSeance(req.params.id);
  if (!seance) return res.json({ isLive: false });
  res.json({
    isLive: true,
    connectedCount: seance.connectedPlayers.size,
    currentChapterId: seance.currentChapterId
  });
});

// ─── Chapitres ───────────────────────────────────────
router.get('/:id/chapters', requireAuth, async (req, res) => {
  const chapters = await adv.listChapters(req.params.id, req.session.userId);
  if (chapters === null) return res.status(404).json({ error: 'Introuvable' });
  res.json(chapters);
});

router.post('/:id/chapters', requireAuth, async (req, res) => {
  try {
    const chapter = await adv.createChapter(req.params.id, req.session.userId, req.body);
    if (!chapter) return res.status(404).json({ error: 'Introuvable' });
    res.status(201).json(chapter);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(400).json({ error: 'Données invalides' });
  }
});

router.put('/:id/chapters/:chapterId', requireAuth, async (req, res) => {
  try {
    const chapter = await adv.updateChapter(req.params.id, req.session.userId, req.params.chapterId, req.body);
    if (!chapter) return res.status(404).json({ error: 'Introuvable' });
    res.json(chapter);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id/chapters/:chapterId', requireAuth, async (req, res) => {
  const ok = await adv.deleteChapter(req.params.id, req.session.userId, req.params.chapterId);
  if (!ok) return res.status(404).json({ error: 'Introuvable' });
  res.json({ success: true });
});

router.post('/:id/chapters/:chapterId/set-current', requireAuth, async (req, res) => {
  const chapters = await adv.setCurrentChapter(req.params.id, req.session.userId, req.params.chapterId);
  if (!chapters) return res.status(404).json({ error: 'Introuvable' });
  res.json(chapters);
});

// ─── PNJ ─────────────────────────────────────────────
router.get('/:id/npcs', requireAuth, async (req, res) => {
  const npcs = await adv.listNpcs(req.params.id, req.session.userId);
  if (npcs === null) return res.status(404).json({ error: 'Introuvable' });
  res.json(npcs);
});

router.post('/:id/npcs', requireAuth, async (req, res) => {
  try {
    const npc = await adv.createNpc(req.params.id, req.session.userId, req.body);
    if (!npc) return res.status(404).json({ error: 'Introuvable' });
    res.status(201).json(npc);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(400).json({ error: 'Données invalides' });
  }
});

router.put('/:id/npcs/:npcId', requireAuth, async (req, res) => {
  try {
    const npc = await adv.updateNpc(req.params.id, req.session.userId, req.params.npcId, req.body);
    if (!npc) return res.status(404).json({ error: 'Introuvable' });
    res.json(npc);
  } catch (e) {
    console.error('Erreur:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/:id/npcs/:npcId', requireAuth, async (req, res) => {
  const ok = await adv.deleteNpc(req.params.id, req.session.userId, req.params.npcId);
  if (!ok) return res.status(404).json({ error: 'Introuvable' });
  res.json({ success: true });
});

router.post('/:id/npcs/:npcId/token', requireAuth, handleUpload(uploadToken.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const npc = await adv.createNpcToken(req.params.id, req.session.userId, req.params.npcId, req.file);
  if (!npc) return res.status(404).json({ error: 'Introuvable' });
  res.status(201).json(npc);
});

// ─── Médias ──────────────────────────────────────────
router.post('/:id/media/map', requireAuth, handleUpload(uploadMap.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const media = await adv.createMedia(req.params.id, req.session.userId, 'map', req.file);
  if (!media) return res.status(404).json({ error: 'Introuvable' });
  res.status(201).json(media);
});

router.post('/:id/media/music', requireAuth, handleUpload(uploadMusic.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const media = await adv.createMedia(req.params.id, req.session.userId, 'music', req.file);
  if (!media) return res.status(404).json({ error: 'Introuvable' });
  res.status(201).json(media);
});

router.post('/:id/media/sprite', requireAuth, handleUpload(uploadSprite.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const media = await adv.createMedia(req.params.id, req.session.userId, 'sprite', req.file);
  if (!media) return res.status(404).json({ error: 'Introuvable' });
  res.status(201).json(media);
});

// Document texte (.txt) déposé par le MJ, ensuite attaché à une entrée de journal ou à l'inventaire
// d'un personnage — upload réservé au MJ (propriétaire), lecture ouverte à l'owner et aux membres
// via la route /media/:mediaId/file déjà authentifiée.
router.post('/:id/media/document', requireAuth, handleUpload(uploadDocument.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const media = await adv.createMedia(req.params.id, req.session.userId, 'document', req.file);
  if (!media) return res.status(404).json({ error: 'Introuvable' });
  res.status(201).json(media);
});

router.get('/:id/media', requireAuth, async (req, res) => {
  const media = await adv.listMedia(req.params.id, req.session.userId, req.query.kind);
  if (media === null) return res.status(403).json({ error: 'Accès refusé' });
  res.json(media);
});

router.get('/:id/media/:mediaId/file', requireAuth, async (req, res) => {
  const media = await adv.getMediaFile(req.params.id, req.params.mediaId, req.session.userId);
  if (!media) return res.status(404).json({ error: 'Introuvable' });
  const filePath = path.join(UPLOAD_ROOT, req.params.id, media.filename);
  res.setHeader('Content-Type', media.mimeType);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Fichier introuvable' });
  });
});

router.delete('/:id/media/:mediaId', requireAuth, async (req, res) => {
  const ok = await adv.deleteMedia(req.params.id, req.session.userId, req.params.mediaId);
  if (!ok) return res.status(404).json({ error: 'Introuvable' });
  res.json({ success: true });
});

// ─── Vue MJ : tous les personnages de l'aventure ─────
router.get('/:id/characters', requireAuth, async (req, res) => {
  const characters = await adv.listCharacters(req.params.id, req.session.userId);
  if (characters === null) return res.status(404).json({ error: 'Introuvable' });
  res.json(characters);
});

// ─── Personnages persistants du joueur (plusieurs possibles sur une même aventure) ───
router.get('/:id/character', requireAuth, async (req, res) => {
  res.json(await adv.listCharactersForPlayer(req.params.id, req.session.userId));
});

router.post('/:id/character', requireAuth, async (req, res) => {
  const result = await adv.createCharacter(req.params.id, req.session.userId, req.body);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Aventure introuvable' });
  if (result.error === 'invalid_stats') return res.status(400).json({ error: result.message });
  res.status(201).json(result.character);
});

router.put('/:id/character/:characterId', requireAuth, async (req, res) => {
  const character = await adv.updateCharacterProfile(req.params.id, req.session.userId, req.params.characterId, req.body);
  if (!character) return res.status(404).json({ error: 'Aucun personnage' });
  res.json(character);
});

router.post('/:id/character/:characterId/token', requireAuth, handleUpload(uploadToken.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const character = await adv.createCharacterToken(req.params.id, req.session.userId, req.params.characterId, req.file);
  if (!character) return res.status(404).json({ error: 'Aucun personnage' });
  res.status(201).json(character);
});

module.exports = { router };
