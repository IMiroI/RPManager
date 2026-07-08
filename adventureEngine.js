// ============================================
// adventureEngine.js — État en mémoire des séances Aventure en direct
// ============================================

// roleplayId (string) -> { connectedPlayers, gmSocketId, currentChapterId, nowShowing, nowPlaying, openedAt }
const liveSessions = new Map();

function openSeance(roleplayId) {
  if (liveSessions.has(roleplayId)) return liveSessions.get(roleplayId);
  const state = {
    connectedPlayers: new Map(), // socketId -> { userId, characterId, name, icon, tokenMediaId }
    gmSocketId: null,
    currentChapterId: null,
    nowShowing: null, // { mediaId }
    // Carte préparée (nowShowing) mais pas encore montrée aux joueurs — laisse au MJ le temps de
    // placer tokens/sprites et de peindre le brouillard avant de révéler la scène. Repasse à false
    // à chaque changement de carte (adv:gm:showMedia), pour repartir en préparation à chaque fois.
    mapVisible: false,
    nowPlaying: null, // { mediaId, startedAt, paused }
    journal: [], // journal de groupe : chat + jets de dé/compétences, { id, kind, visibility, authorName, authorIcon, authorTokenMediaId, ... }
    initiative: { round: 1, currentTurnId: null, entries: [] }, // suivi d'initiative de combat, transitoire comme le reste de la séance
    openedAt: Date.now()
  };
  liveSessions.set(roleplayId, state);
  return state;
}

function addInitiativeEntry(seance, { kind, entityId, name, icon, tokenMediaId, tokenColor }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const score = rollDice(1, 20).rolls[0];
  const entry = { id, kind, entityId, name, icon: icon || '', tokenMediaId: tokenMediaId || null, tokenColor: tokenColor || '#c9a227', score };
  seance.initiative.entries.push(entry);
  seance.initiative.entries.sort((a, b) => b.score - a.score);
  return entry;
}

function setInitiativeScore(seance, entryId, score) {
  const entry = seance.initiative.entries.find(e => e.id === entryId);
  if (!entry) return null;
  entry.score = Math.max(-999, Math.min(999, parseInt(score) || 0));
  seance.initiative.entries.sort((a, b) => b.score - a.score);
  return entry;
}

function removeInitiativeEntry(seance, entryId) {
  const before = seance.initiative.entries.length;
  seance.initiative.entries = seance.initiative.entries.filter(e => e.id !== entryId);
  if (seance.initiative.currentTurnId === entryId) {
    seance.initiative.currentTurnId = seance.initiative.entries[0]?.id || null;
  }
  return seance.initiative.entries.length !== before;
}

// Avance au participant suivant dans l'ordre trié par score — repère par id (pas par index) pour
// rester correct même si les scores ont été réordonnés depuis le tour précédent. Un tour complet
// (retour au premier participant) incrémente le compteur de round.
function nextInitiativeTurn(seance) {
  const entries = seance.initiative.entries;
  if (!entries.length) { seance.initiative.currentTurnId = null; return seance.initiative; }
  const idx = entries.findIndex(e => e.id === seance.initiative.currentTurnId);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % entries.length;
  if (idx !== -1 && nextIdx === 0) seance.initiative.round += 1;
  seance.initiative.currentTurnId = entries[nextIdx].id;
  return seance.initiative;
}

function resetInitiative(seance) {
  seance.initiative = { round: 1, currentTurnId: null, entries: [] };
  return seance.initiative;
}

const JOURNAL_MAX_ENTRIES = 100;

function addJournalEntry(seance, entry) {
  const full = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), createdAt: Date.now(), ...entry };
  seance.journal.push(full);
  if (seance.journal.length > JOURNAL_MAX_ENTRIES) seance.journal.shift();
  return full;
}

function closeSeance(roleplayId) {
  liveSessions.delete(roleplayId);
}

function getSeance(roleplayId) {
  return liveSessions.get(roleplayId) || null;
}

function isLive(roleplayId) {
  return liveSessions.has(roleplayId);
}

function rollDice(count, sides) {
  const safeCount = Math.min(Math.max(parseInt(count) || 1, 1), 20);
  const safeSides = Math.min(Math.max(parseInt(sides) || 100, 2), 1000);
  const rolls = Array.from({ length: safeCount }, () => 1 + Math.floor(Math.random() * safeSides));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0), count: safeCount, sides: safeSides };
}

module.exports = {
  liveSessions, openSeance, closeSeance, getSeance, isLive, rollDice, addJournalEntry,
  addInitiativeEntry, setInitiativeScore, removeInitiativeEntry, nextInitiativeTurn, resetInitiative
};
