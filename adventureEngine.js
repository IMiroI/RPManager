// ============================================
// adventureEngine.js — État en mémoire des séances Aventure en direct
// ============================================

// roleplayId (string) -> { connectedPlayers, gmSocketId, currentChapterId, nowShowing, nowPlaying, openedAt }
const liveSessions = new Map();

function openSeance(roleplayId) {
  if (liveSessions.has(roleplayId)) return liveSessions.get(roleplayId);
  const state = {
    connectedPlayers: new Map(), // socketId -> { userId, characterId, name }
    gmSocketId: null,
    currentChapterId: null,
    nowShowing: null, // { mediaId }
    nowPlaying: null, // { mediaId, startedAt, paused }
    openedAt: Date.now()
  };
  liveSessions.set(roleplayId, state);
  return state;
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

module.exports = { liveSessions, openSeance, closeSeance, getSeance, isLive, rollDice };
