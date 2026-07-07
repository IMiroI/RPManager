// ============================================
// adventuresManager.js — CRUD chapitres/PNJ/médias pour les roleplays de type "aventure"
// ============================================
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const Roleplay = require('./models/Roleplay');
const Media = require('./models/Media');
const AdventureCharacter = require('./models/AdventureCharacter');
const { UPLOAD_ROOT } = require('./uploadStorage');

function newId() {
  return randomBytes(6).toString('hex');
}

// Valide une couleur hex #RGB/#RRGGBB pour le contour du token — retombe sur le doré par défaut
// si absente/invalide (jamais de valeur non fiable injectée dans un attribut style côté client).
function sanitizeTokenColor(color) {
  if (typeof color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim())) return color.trim();
  return '#c9a227';
}

async function getOwnedAdventure(roleplayId, ownerId) {
  const doc = await Roleplay.findOne({ _id: roleplayId, owner: ownerId, type: 'aventure' }).catch(() => null);
  return doc;
}

// Propriétaire OU joueur ayant un personnage sur cette aventure
async function isOwnerOrMember(roleplayId, userId) {
  const rp = await Roleplay.findOne({ _id: roleplayId, type: 'aventure' }).select('owner').catch(() => null);
  if (!rp) return false;
  if (rp.owner.toString() === userId.toString()) return true;
  const character = await AdventureCharacter.exists({ roleplay: roleplayId, player: userId });
  return !!character;
}

async function resolveByInviteCode(code, userId) {
  const doc = await Roleplay.findOne({ inviteCode: code, type: 'aventure' }).catch(() => null);
  if (!doc) return null;

  // Première connexion : le joueur devient membre de l'aventure (visible dans sa liste),
  // même avant d'avoir créé son personnage.
  if (userId && doc.owner.toString() !== userId.toString() && !doc.members.some(m => m.toString() === userId.toString())) {
    doc.members.push(userId);
    await doc.save();
  }

  const rp = doc.toJSON();
  return { id: rp.id, name: rp.name, description: rp.description, themeColor: rp.themeColor, pointBudget: rp.pointBudget, statDefinitions: rp.statDefinitions };
}

// ─── Chapitres ───────────────────────────────────────
async function listChapters(roleplayId, ownerId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  return doc.chapters || [];
}

async function createChapter(roleplayId, ownerId, data) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const chapter = {
    id: newId(),
    title: data.title || 'Nouveau chapitre',
    order: doc.chapters.length,
    gmNotes: data.gmNotes || '',
    npcIds: data.npcIds || [],
    mediaIds: data.mediaIds || [],
    isCurrent: false
  };
  doc.chapters.push(chapter);
  await doc.save();
  return chapter;
}

async function updateChapter(roleplayId, ownerId, chapterId, data) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const chapter = doc.chapters.find(c => c.id === chapterId);
  if (!chapter) return null;

  if (data.title !== undefined) chapter.title = data.title;
  if (data.gmNotes !== undefined) chapter.gmNotes = data.gmNotes;
  if (data.npcIds !== undefined) chapter.npcIds = data.npcIds;
  if (data.mediaIds !== undefined) chapter.mediaIds = data.mediaIds;

  doc.markModified('chapters');
  await doc.save();
  return chapter;
}

async function deleteChapter(roleplayId, ownerId, chapterId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return false;
  const before = doc.chapters.length;
  doc.chapters = doc.chapters.filter(c => c.id !== chapterId);
  if (doc.chapters.length === before) return false;
  await doc.save();
  return true;
}

async function setCurrentChapter(roleplayId, ownerId, chapterId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  let found = false;
  doc.chapters.forEach(c => {
    c.isCurrent = c.id === chapterId;
    if (c.isCurrent) found = true;
  });
  if (!found) return null;
  doc.markModified('chapters');
  await doc.save();
  return doc.chapters;
}

// ─── PNJ ─────────────────────────────────────────────
async function listNpcs(roleplayId, ownerId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  return doc.npcs || [];
}

async function createNpc(roleplayId, ownerId, data) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const npc = {
    id: newId(),
    name: data.name || 'Nouveau PNJ',
    icon: data.icon || '❓',
    role: data.role || '',
    disposition: data.disposition || 'neutre',
    backstory: data.backstory || '',
    stats: data.stats || {},
    visibleSkills: data.visibleSkills || [],
    hiddenSkills: data.hiddenSkills || [],
    tokenColor: sanitizeTokenColor(data.tokenColor)
  };
  doc.npcs.push(npc);
  await doc.save();
  return npc;
}

async function updateNpc(roleplayId, ownerId, npcId, data) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const npc = doc.npcs.find(n => n.id === npcId);
  if (!npc) return null;

  if (data.name !== undefined) npc.name = data.name;
  if (data.icon !== undefined) npc.icon = data.icon;
  if (data.role !== undefined) npc.role = data.role;
  if (data.disposition !== undefined) npc.disposition = data.disposition;
  if (data.backstory !== undefined) npc.backstory = data.backstory;
  if (data.stats !== undefined) npc.stats = data.stats;
  if (data.visibleSkills !== undefined) npc.visibleSkills = data.visibleSkills;
  if (data.hiddenSkills !== undefined) npc.hiddenSkills = data.hiddenSkills;
  if (data.tokenColor !== undefined) npc.tokenColor = sanitizeTokenColor(data.tokenColor);

  doc.markModified('npcs');
  await doc.save();
  return npc;
}

async function deleteNpc(roleplayId, ownerId, npcId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return false;
  const before = doc.npcs.length;
  doc.npcs = doc.npcs.filter(n => n.id !== npcId);
  if (doc.npcs.length === before) return false;
  await doc.save();
  return true;
}

// ─── Médias ──────────────────────────────────────────
async function createMedia(roleplayId, ownerId, kind, file) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const media = await Media.create({
    roleplay: roleplayId,
    owner: ownerId,
    kind,
    originalName: file.originalname,
    filename: file.filename,
    mimeType: file.mimetype,
    size: file.size
  });
  return media.toJSON();
}

async function listMedia(roleplayId, requesterId, kind) {
  const allowed = await isOwnerOrMember(roleplayId, requesterId);
  if (!allowed) return null;
  const filter = { roleplay: roleplayId };
  if (kind) filter.kind = kind;
  const docs = await Media.find(filter).sort({ createdAt: -1 });
  return docs.map(d => d.toJSON());
}

async function getMediaFile(roleplayId, mediaId, requesterId) {
  const allowed = await isOwnerOrMember(roleplayId, requesterId);
  if (!allowed) return null;
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId }).catch(() => null);
  return media;
}

async function deleteMedia(roleplayId, ownerId, mediaId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return false;
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId }).catch(() => null);
  if (!media) return false;
  const filePath = path.join(UPLOAD_ROOT, roleplayId, media.filename);
  await Media.deleteOne({ _id: mediaId });
  fs.unlink(filePath, () => {});
  return true;
}

// ─── Personnage persistant du joueur ────────────────
// Les statistiques sont librement définies par le MJ (roleplay.statDefinitions) —
// toutes facultatives, y compris des stats inventées. On ne valide/ne garde que ces clés-là.
function sanitizeAndValidateStats(stats, statDefinitions, pointBudget) {
  if (!stats || typeof stats !== 'object') return { error: 'Statistiques manquantes' };
  const sanitized = {};
  let sum = 0;
  for (const def of statDefinitions || []) {
    const v = stats[def.key];
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      return { error: `Statistique "${def.label}" invalide (doit être un entier entre 1 et 10)` };
    }
    sanitized[def.key] = v;
    sum += v;
  }
  if (sum > pointBudget) return { error: `Le total des statistiques (${sum}) dépasse le budget de points (${pointBudget})` };
  return { stats: sanitized };
}

function sanitizeSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter(s => s && typeof s.name === 'string' && s.name.trim())
    .slice(0, 12)
    .map(s => ({
      id: newId(),
      name: s.name.trim().slice(0, 60),
      description: (s.description || '').trim().slice(0, 300),
      diceSides: Math.min(1000, Math.max(2, parseInt(s.diceSides) || 6))
    }));
}

// Un joueur peut avoir plusieurs personnages sur une même aventure — toujours retourné en liste.
async function listCharactersForPlayer(roleplayId, playerId) {
  const docs = await AdventureCharacter.find({ roleplay: roleplayId, player: playerId }).catch(() => []);
  return docs.map(d => d.toJSON());
}

async function createCharacter(roleplayId, playerId, data) {
  const rp = await Roleplay.findOne({ _id: roleplayId, type: 'aventure' }).catch(() => null);
  if (!rp) return { error: 'not_found' };

  const { error: validationError, stats } = sanitizeAndValidateStats(data.stats, rp.statDefinitions, rp.pointBudget);
  if (validationError) return { error: 'invalid_stats', message: validationError };

  const doc = await AdventureCharacter.create({
    roleplay: roleplayId,
    player: playerId,
    name: data.name,
    icon: (data.icon || '❓').trim().slice(0, 4) || '❓',
    tokenColor: sanitizeTokenColor(data.tokenColor),
    backstory: data.backstory || '',
    skills: sanitizeSkills(data.skills),
    stats
  });
  return { character: doc.toJSON() };
}

async function updateCharacterProfile(roleplayId, playerId, characterId, data) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId, player: playerId }).catch(() => null);
  if (!doc) return null;
  if (data.name !== undefined) doc.name = data.name;
  if (data.icon !== undefined) doc.icon = (data.icon || '❓').trim().slice(0, 4) || '❓';
  if (data.tokenColor !== undefined) doc.tokenColor = sanitizeTokenColor(data.tokenColor);
  if (data.backstory !== undefined) doc.backstory = data.backstory;
  if (data.skills !== undefined) doc.skills = sanitizeSkills(data.skills);
  await doc.save();
  return doc.toJSON();
}

// Vue "Gestion de mes personnages" (dashboard) : tous les personnages du joueur, toutes aventures
// confondues, avec de quoi les relier (nom/couleur/lien d'invitation de l'aventure).
async function listCharactersAcrossAdventures(userId) {
  const docs = await AdventureCharacter.find({ player: userId }).populate('roleplay', 'name themeColor inviteCode').catch(() => []);
  return docs
    .filter(c => c.roleplay && c.roleplay.inviteCode)
    .map(c => ({
      id: c._id.toString(),
      name: c.name,
      icon: c.icon,
      tokenMediaId: c.tokenMediaId,
      backstory: c.backstory,
      roleplayId: c.roleplay._id.toString(),
      roleplayName: c.roleplay.name,
      roleplayThemeColor: c.roleplay.themeColor,
      roleplayInviteCode: c.roleplay.inviteCode
    }));
}

// ─── Vue MJ sur les personnages (toutes, hors budget) ────
async function listCharacters(roleplayId, ownerId) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const chars = await AdventureCharacter.find({ roleplay: roleplayId }).populate('player', 'username');
  return chars.map(c => {
    const json = c.toJSON();
    json.playerUsername = c.player?.username;
    return json;
  });
}

async function updateCharacterStatsById(roleplayId, characterId, stats) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  const rp = await Roleplay.findById(roleplayId).select('statDefinitions').catch(() => null);
  const keys = rp ? rp.statDefinitions.map(d => d.key) : Object.keys(stats || {});
  if (!doc.stats) doc.stats = {};
  for (const key of keys) {
    if (stats[key] !== undefined) doc.stats[key] = Math.min(99, Math.max(0, parseInt(stats[key]) || 0));
  }
  doc.markModified('stats');
  await doc.save();
  return doc.toJSON();
}

async function updateCharacterInventoryById(roleplayId, characterId, inventory) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  doc.inventory = Array.isArray(inventory) ? inventory.map(String) : [];
  await doc.save();
  return doc.toJSON();
}

async function updateCharacterSkillsById(roleplayId, characterId, skills) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  doc.skills = sanitizeSkills(skills);
  await doc.save();
  return doc.toJSON();
}

async function appendJournalEntry(roleplayId, characterId, text, authorRole) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  const entry = { id: newId(), text, authorRole, createdAt: new Date() };
  doc.journal.push(entry);
  await doc.save();
  return doc.toJSON();
}

async function getCharacterById(roleplayId, characterId) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  return doc.toJSON();
}

// ─── Messagerie privée (persistée, source de vérité = Mongo) ────
async function appendPrivateMessage(roleplayId, characterId, text, from) {
  const doc = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId }).catch(() => null);
  if (!doc) return null;
  const msg = { id: newId(), text, from, createdAt: new Date() };
  doc.messages.push(msg);
  await doc.save();
  return doc.toJSON();
}

// ─── Token de personnage (image + position sur carte) ──────────
async function createCharacterToken(roleplayId, playerId, characterId, file) {
  const character = await AdventureCharacter.findOne({ _id: characterId, roleplay: roleplayId, player: playerId }).catch(() => null);
  if (!character) return null;

  if (character.tokenMediaId) {
    const oldMedia = await Media.findOne({ _id: character.tokenMediaId, roleplay: roleplayId }).catch(() => null);
    if (oldMedia) {
      fs.unlink(path.join(UPLOAD_ROOT, roleplayId, oldMedia.filename), () => {});
      await Media.deleteOne({ _id: oldMedia._id });
    }
  }

  const media = await Media.create({
    roleplay: roleplayId,
    owner: playerId,
    kind: 'token',
    originalName: file.originalname,
    filename: file.filename,
    mimeType: file.mimetype,
    size: file.size
  });

  character.tokenMediaId = media._id.toString();
  await character.save();
  return character.toJSON();
}

async function createNpcToken(roleplayId, ownerId, npcId, file) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  const npc = doc.npcs.find(n => n.id === npcId);
  if (!npc) return null;

  if (npc.tokenMediaId) {
    const oldMedia = await Media.findOne({ _id: npc.tokenMediaId, roleplay: roleplayId }).catch(() => null);
    if (oldMedia) {
      fs.unlink(path.join(UPLOAD_ROOT, roleplayId, oldMedia.filename), () => {});
      await Media.deleteOne({ _id: oldMedia._id });
    }
  }

  const media = await Media.create({
    roleplay: roleplayId,
    owner: ownerId,
    kind: 'token',
    originalName: file.originalname,
    filename: file.filename,
    mimeType: file.mimetype,
    size: file.size
  });

  npc.tokenMediaId = media._id.toString();
  doc.markModified('npcs');
  await doc.save();
  return npc;
}

async function listPartyMembers(roleplayId) {
  const chars = await AdventureCharacter.find({ roleplay: roleplayId }).select('name icon tokenMediaId tokenColor');
  return chars.map(c => ({ id: c._id.toString(), name: c.name, icon: c.icon, tokenMediaId: c.tokenMediaId, tokenColor: c.tokenColor }));
}

// Vue publique des PNJ (nom/icône/token) — sans stats/compétences/notes MJ — envoyée aux joueurs
// pour qu'ils voient les tokens des PNJ sur la carte sans révéler leurs infos.
async function listNpcRoster(roleplayId) {
  const doc = await Roleplay.findById(roleplayId).select('npcs').catch(() => null);
  if (!doc) return [];
  return (doc.npcs || []).map(n => ({ id: n.id, name: n.name, icon: n.icon, tokenMediaId: n.tokenMediaId || null, tokenColor: n.tokenColor || '#c9a227' }));
}

async function getMapTokenPositions(roleplayId, mediaId) {
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId, kind: 'map' }).catch(() => null);
  return media ? media.tokenPositions : [];
}

async function setTokenPosition(roleplayId, mediaId, characterId, x, y, kind, spriteMediaId) {
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId, kind: 'map' }).catch(() => null);
  if (!media) return null;
  const safeX = Math.min(100, Math.max(0, Number(x) || 0));
  const safeY = Math.min(100, Math.max(0, Number(y) || 0));
  const safeKind = ['npc', 'sprite'].includes(kind) ? kind : 'character';
  const existing = media.tokenPositions.find(p => p.characterId === characterId);
  if (existing) {
    existing.x = safeX; existing.y = safeY; existing.kind = safeKind;
    if (safeKind === 'sprite' && spriteMediaId) existing.spriteMediaId = spriteMediaId;
  } else {
    const entry = { characterId, kind: safeKind, x: safeX, y: safeY, rotation: 0 };
    if (safeKind === 'sprite') entry.spriteMediaId = spriteMediaId || null;
    media.tokenPositions.push(entry);
  }
  media.markModified('tokenPositions');
  await media.save();
  return media.tokenPositions;
}

async function setTokenRotation(roleplayId, mediaId, characterId, rotation) {
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId, kind: 'map' }).catch(() => null);
  if (!media) return null;
  const existing = media.tokenPositions.find(p => p.characterId === characterId);
  if (!existing) return null;
  existing.rotation = ((Number(rotation) || 0) % 360 + 360) % 360;
  media.markModified('tokenPositions');
  await media.save();
  return media.tokenPositions;
}

async function removeTokenPosition(roleplayId, mediaId, characterId) {
  const media = await Media.findOne({ _id: mediaId, roleplay: roleplayId, kind: 'map' }).catch(() => null);
  if (!media) return null;
  const before = media.tokenPositions.length;
  media.tokenPositions = media.tokenPositions.filter(p => p.characterId !== characterId);
  if (media.tokenPositions.length === before) return media.tokenPositions;
  media.markModified('tokenPositions');
  await media.save();
  return media.tokenPositions;
}

// Nombre de colonnes de la grille tactique (carrée) — le MJ en règle la taille via un curseur,
// les tokens sont ensuite toujours affichés à la taille d'une case (calculée côté client).
async function setGridSize(roleplayId, ownerId, gridSize) {
  const doc = await getOwnedAdventure(roleplayId, ownerId);
  if (!doc) return null;
  doc.gridSize = Math.min(60, Math.max(5, parseInt(gridSize) || 20));
  await doc.save();
  return doc.gridSize;
}

// Lecture d'un PNJ précis (pour le jet de compétence PNJ, réservé au MJ côté serveur)
async function getNpcById(roleplayId, npcId) {
  const doc = await Roleplay.findById(roleplayId).select('npcs').catch(() => null);
  if (!doc) return null;
  return (doc.npcs || []).find(n => n.id === npcId) || null;
}

// ─── Synchro des fiches PNJ/joueurs quand le MJ ajoute/retire une statistique ────
async function syncStatDefinitions(roleplayId, oldDefs, newDefs) {
  const oldKeys = (oldDefs || []).map(d => d.key);
  const newKeys = (newDefs || []).map(d => d.key);
  const added = newKeys.filter(k => !oldKeys.includes(k));
  const removed = oldKeys.filter(k => !newKeys.includes(k));
  if (added.length === 0 && removed.length === 0) return;

  const doc = await Roleplay.findById(roleplayId);
  if (doc) {
    let changed = false;
    doc.npcs.forEach(npc => {
      if (!npc.stats) npc.stats = {};
      for (const key of added) { if (npc.stats[key] === undefined) { npc.stats[key] = 1; changed = true; } }
      for (const key of removed) { if (npc.stats[key] !== undefined) { delete npc.stats[key]; changed = true; } }
    });
    if (changed) { doc.markModified('npcs'); await doc.save(); }
  }

  const characters = await AdventureCharacter.find({ roleplay: roleplayId });
  for (const character of characters) {
    let changed = false;
    if (!character.stats) character.stats = {};
    for (const key of added) { if (character.stats[key] === undefined) { character.stats[key] = 1; changed = true; } }
    for (const key of removed) { if (character.stats[key] !== undefined) { delete character.stats[key]; changed = true; } }
    if (changed) { character.markModified('stats'); await character.save(); }
  }
}

module.exports = {
  getOwnedAdventure,
  isOwnerOrMember,
  resolveByInviteCode,
  listChapters, createChapter, updateChapter, deleteChapter, setCurrentChapter,
  listNpcs, createNpc, updateNpc, deleteNpc,
  createMedia, listMedia, getMediaFile, deleteMedia,
  listCharactersForPlayer, createCharacter, updateCharacterProfile, listCharactersAcrossAdventures,
  listCharacters, updateCharacterStatsById, updateCharacterInventoryById, updateCharacterSkillsById, appendJournalEntry, getCharacterById,
  appendPrivateMessage,
  createCharacterToken, createNpcToken, listPartyMembers, listNpcRoster, getMapTokenPositions, setTokenPosition,
  setTokenRotation, removeTokenPosition, getNpcById, setGridSize,
  syncStatDefinitions
};
