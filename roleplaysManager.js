// ============================================
// roleplaysManager.js — CRUD pour les configs de roleplay
// ============================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'roleplays');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || `roleplay-${Date.now()}`;
}

function getAllRoleplays() {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return {
        id: data.id,
        name: data.name,
        description: data.description,
        themeColor: data.themeColor || '#8B6914',
        characterCount: data.characters?.length || 0,
        maxPlayers: data.maxPlayers || 10,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getRoleplay(id) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createRoleplay(data) {
  ensureDataDir();
  const id = slugify(data.name || 'nouveau-roleplay');
  const now = new Date().toISOString();

  const roleplay = {
    ...data,
    id,
    characters: data.characters || [],
    scenarioSteps: data.scenarioSteps || [],
    maxPlayers: data.maxPlayers || 10,
    themeColor: data.themeColor || '#8B6914',
    createdAt: now,
    updatedAt: now
  };

  const filePath = path.join(DATA_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(roleplay, null, 2), 'utf8');
  return roleplay;
}

function updateRoleplay(id, data) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const updated = {
    ...existing,
    ...data,
    id,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

function deleteRoleplay(id) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

module.exports = { getAllRoleplays, getRoleplay, createRoleplay, updateRoleplay, deleteRoleplay };
