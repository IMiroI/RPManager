// ============================================
// roleplaysManager.js — CRUD pour les configs de roleplay (MongoDB)
// ============================================

const { randomBytes } = require('crypto');
const Roleplay = require('./models/Roleplay');

const TYPES = ['oneshot', 'aventure'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function safeType(type) {
  return TYPES.includes(type) ? type : 'oneshot';
}

async function generateInviteCode() {
  let code;
  let existing;
  do {
    const buf = randomBytes(6);
    code = Array.from(buf).map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    existing = await Roleplay.findOne({ inviteCode: code }).select('_id');
  } while (existing);
  return code;
}

function slugifyKey(str) {
  return String(str || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'stat';
}

// Le MJ choisit librement les statistiques (par défaut ou inventées) — toutes facultatives.
function sanitizeStatDefinitions(defs) {
  if (!Array.isArray(defs)) return Roleplay.DEFAULT_STAT_DEFINITIONS.map(d => ({ ...d }));
  const seen = new Set();
  const result = [];
  for (const d of defs) {
    const label = String(d?.label || '').trim().slice(0, 40);
    if (!label) continue;
    let key = slugifyKey(d?.key || label);
    let suffix = 1;
    while (seen.has(key)) { key = `${slugifyKey(d?.key || label)}_${++suffix}`; }
    seen.add(key);
    result.push({ key, label });
    if (result.length >= 20) break;
  }
  return result;
}

async function getAllRoleplays(userId) {
  const docs = await Roleplay.find({
    $or: [{ owner: userId }, { type: 'aventure', members: userId }]
  }).sort({ updatedAt: -1 });

  return docs.map(doc => {
    const role = doc.owner.toString() === userId.toString() ? 'gm' : 'player';
    const rp = doc.toJSON();
    return {
      id: rp.id,
      type: rp.type,
      role,
      name: rp.name,
      description: rp.description,
      themeColor: rp.themeColor,
      characterCount: rp.characters?.length || 0,
      maxPlayers: rp.maxPlayers,
      inviteCode: rp.inviteCode,
      npcCount: rp.npcs?.length || 0,
      chapterCount: rp.chapters?.length || 0,
      createdAt: rp.createdAt,
      updatedAt: rp.updatedAt
    };
  });
}

async function getRoleplay(id, ownerId) {
  const doc = await Roleplay.findOne({ _id: id, owner: ownerId }).catch(() => null);
  if (!doc) return null;
  return doc.toJSON();
}

async function createRoleplay(data, ownerId) {
  const type = safeType(data.type);
  const doc = await Roleplay.create({
    owner: ownerId,
    type,
    name: data.name,
    description: data.description || '',
    themeColor: data.themeColor || '#8B6914',
    maxPlayers: data.maxPlayers || 10,
    characters: data.characters || [],
    scenarioSteps: data.scenarioSteps || [],
    inviteCode: type === 'aventure' ? await generateInviteCode() : undefined,
    npcs: data.npcs || [],
    chapters: data.chapters || [],
    pointBudget: data.pointBudget || 30,
    statDefinitions: data.statDefinitions !== undefined ? sanitizeStatDefinitions(data.statDefinitions) : undefined
  });
  return doc.toJSON();
}

async function updateRoleplay(id, data, ownerId) {
  const doc = await Roleplay.findOne({ _id: id, owner: ownerId }).catch(() => null);
  if (!doc) return null;

  if (data.type !== undefined) doc.type = safeType(data.type);
  if (data.name !== undefined) doc.name = data.name;
  if (data.description !== undefined) doc.description = data.description;
  if (data.themeColor !== undefined) doc.themeColor = data.themeColor;
  if (data.maxPlayers !== undefined) doc.maxPlayers = data.maxPlayers;
  if (data.characters !== undefined) doc.characters = data.characters;
  if (data.scenarioSteps !== undefined) doc.scenarioSteps = data.scenarioSteps;
  if (data.npcs !== undefined) doc.npcs = data.npcs;
  if (data.chapters !== undefined) doc.chapters = data.chapters;
  if (data.pointBudget !== undefined) doc.pointBudget = data.pointBudget;
  if (data.statDefinitions !== undefined) doc.statDefinitions = sanitizeStatDefinitions(data.statDefinitions);

  await doc.save();
  return doc.toJSON();
}

async function deleteRoleplay(id, ownerId) {
  const result = await Roleplay.deleteOne({ _id: id, owner: ownerId }).catch(() => ({ deletedCount: 0 }));
  return result.deletedCount > 0;
}

module.exports = { getAllRoleplays, getRoleplay, createRoleplay, updateRoleplay, deleteRoleplay };
