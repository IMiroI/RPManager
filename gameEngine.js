// ============================================
// gameEngine.js — Moteur de jeu générique
// ============================================

const PHASES = {
  LOBBY: 'lobby',
  CARD_SELECTION: 'card_selection',
  PLAYING: 'playing'
};

class GameEngine {
  constructor(roleplay) {
    this.roleplay = roleplay;
    this.phase = PHASES.LOBBY;
    this.players = new Map();
    this.gmSocketId = null;
    this.allCharacters = [...(roleplay.characters || [])];
    this.availableCharacters = [];
    this.globalPool = [];
    this.currentStepIndex = null;
    this.validatedStepIndices = [];
  }

  // ─── Player Management ────────────────────────────

  addPlayer(socketId, name) {
    if (this.phase !== PHASES.LOBBY) {
      return { success: false, error: 'La partie a déjà commencé.' };
    }
    const maxPlayers = this.roleplay.maxPlayers || 10;
    if (this.players.size >= maxPlayers) {
      return { success: false, error: `Maximum ${maxPlayers} joueurs atteint.` };
    }
    for (const [, player] of this.players) {
      if (player.name.toLowerCase() === name.toLowerCase()) {
        return { success: false, error: 'Ce pseudo est déjà pris.' };
      }
    }
    this.players.set(socketId, {
      name,
      cards: [],
      flippedCards: [],
      selectedCharacter: null,
      selectionValidated: false,
      revealedSkills: [],
      messages: [],
      inventory: [],
      connected: true
    });
    return { success: true };
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;
    if (this.phase === PHASES.LOBBY) {
      this.players.delete(socketId);
    } else {
      player.connected = false;
    }
  }

  reconnectPlayer(socketId, name) {
    for (const [oldId, player] of this.players) {
      if (player.name.toLowerCase() === name.toLowerCase() && !player.connected) {
        const data = { ...player, connected: true };
        this.players.delete(oldId);
        this.players.set(socketId, data);
        return { success: true, player: data };
      }
    }
    return { success: false };
  }

  setGM(socketId) {
    this.gmSocketId = socketId;
  }

  // ─── Card Distribution ────────────────────────────

  distributeCards() {
    if (this.phase !== PHASES.LOBBY) {
      return { success: false, error: 'Les cartes ont déjà été distribuées.' };
    }
    const playerCount = this.getConnectedPlayerCount();
    if (playerCount < 1) {
      return { success: false, error: 'Il faut au moins 1 joueur.' };
    }

    this.availableCharacters = this.shuffle([...this.allCharacters]);
    const cardsPerPlayer = Math.floor(this.availableCharacters.length / playerCount);
    const extraCards = this.availableCharacters.length % playerCount;

    let cardIndex = 0;
    let playerIndex = 0;
    this.globalPool = [];

    for (const [, player] of this.players) {
      if (!player.connected) continue;
      const count = cardsPerPlayer + (playerIndex < extraCards ? 1 : 0);
      player.cards = this.availableCharacters.slice(cardIndex, cardIndex + count).map(c => c.id);
      player.flippedCards = [];
      player.selectedCharacter = null;
      player.selectionValidated = false;
      cardIndex += count;
      playerIndex++;
    }

    this.phase = PHASES.CARD_SELECTION;
    return { success: true };
  }

  // ─── Card Actions ─────────────────────────────────

  flipCard(socketId, characterId) {
    const player = this.players.get(socketId);
    if (!player || this.phase !== PHASES.CARD_SELECTION) {
      return { success: false, error: 'Action non disponible.' };
    }
    if (!player.cards.includes(characterId)) {
      return { success: false, error: 'Cette carte ne vous appartient pas.' };
    }
    if (player.flippedCards.includes(characterId)) {
      return { success: false, error: 'Carte déjà retournée.' };
    }
    if (player.selectedCharacter) {
      return { success: false, error: 'Vous avez déjà choisi.' };
    }

    player.flippedCards.push(characterId);
    const character = this.getCharacterById(characterId);
    return { success: true, character: this.getCardPreview(character) };
  }

  selectCard(socketId, characterId) {
    const player = this.players.get(socketId);
    if (!player || this.phase !== PHASES.CARD_SELECTION) {
      return { success: false, error: 'Action non disponible.' };
    }
    if (!player.flippedCards.includes(characterId)) {
      return { success: false, error: 'Retournez d\'abord la carte.' };
    }
    if (player.selectedCharacter) {
      return { success: false, error: 'Vous avez déjà choisi un personnage.' };
    }

    player.selectedCharacter = characterId;
    player.selectionValidated = false;

    const returnedCards = player.cards.filter(id => id !== characterId);
    this.globalPool.push(...returnedCards);
    player.cards = [characterId];
    player.flippedCards = [characterId];

    return { success: true, selectedCharacter: characterId, returnedCards };
  }

  swapCard(socketId, targetCharacterId) {
    const player = this.players.get(socketId);
    if (!player || this.phase !== PHASES.CARD_SELECTION) {
      return { success: false, error: 'Action non disponible.' };
    }
    if (!player.selectedCharacter) {
      return { success: false, error: 'Vous devez d\'abord choisir un personnage.' };
    }
    if (player.selectionValidated) {
      return { success: false, error: 'Votre sélection est validée définitivement.' };
    }

    const poolIndex = this.globalPool.indexOf(targetCharacterId);
    if (poolIndex === -1) {
      return { success: false, error: 'Cette carte n\'est plus disponible dans le pool.' };
    }

    const currentCharacterId = player.selectedCharacter;
    this.globalPool.splice(poolIndex, 1);
    this.globalPool.push(currentCharacterId);

    player.selectedCharacter = targetCharacterId;
    player.cards = [targetCharacterId];
    player.flippedCards = [targetCharacterId];

    return { success: true, selectedCharacter: targetCharacterId, swappedOut: currentCharacterId };
  }

  validateSelection(socketId) {
    const player = this.players.get(socketId);
    if (!player || this.phase !== PHASES.CARD_SELECTION) {
      return { success: false, error: 'Action non disponible.' };
    }
    if (!player.selectedCharacter) {
      return { success: false, error: 'Vous devez d\'abord choisir un personnage.' };
    }
    if (player.selectionValidated) {
      return { success: false, error: 'Sélection déjà validée.' };
    }
    player.selectionValidated = true;
    return { success: true };
  }

  // ─── Game Control ─────────────────────────────────

  startGame() {
    if (this.phase !== PHASES.CARD_SELECTION) {
      return { success: false, error: 'La sélection de cartes n\'est pas terminée.' };
    }
    for (const [, player] of this.players) {
      if (player.connected && !player.selectionValidated) {
        return { success: false, error: `${player.name} n'a pas encore validé son personnage.` };
      }
    }
    this.phase = PHASES.PLAYING;
    return { success: true };
  }

  resetGame() {
    this.phase = PHASES.LOBBY;
    this.availableCharacters = [];
    this.globalPool = [];
    this.currentStepIndex = null;
    this.validatedStepIndices = [];
    for (const [, player] of this.players) {
      player.cards = [];
      player.flippedCards = [];
      player.selectedCharacter = null;
      player.selectionValidated = false;
      player.revealedSkills = [];
      player.messages = [];
      player.inventory = [];
    }
  }

  // ─── GM Actions ───────────────────────────────────

  revealSkill(targetSocketId, skillId) {
    const player = this.players.get(targetSocketId);
    if (!player || !player.selectedCharacter) {
      return { success: false, error: 'Joueur ou personnage introuvable.' };
    }
    const character = this.getCharacterById(player.selectedCharacter);
    const skill = character.hiddenSkills.find(s => s.id === skillId);
    if (!skill) return { success: false, error: 'Compétence introuvable.' };
    if (player.revealedSkills.includes(skillId)) {
      return { success: false, error: 'Compétence déjà révélée.' };
    }
    player.revealedSkills.push(skillId);
    return { success: true, skill };
  }

  sendPrivateMessage(targetSocketId, message) {
    const player = this.players.get(targetSocketId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };
    const msg = { id: Date.now(), text: message, from: 'gm', timestamp: new Date().toISOString() };
    player.messages.push(msg);
    return { success: true, message: msg };
  }

  receivePlayerMessage(socketId, text) {
    const player = this.players.get(socketId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };
    const msg = { id: Date.now(), text, from: 'player', timestamp: new Date().toISOString() };
    player.messages.push(msg);
    return { success: true, message: msg, playerName: player.name };
  }

  rollDice(socketId, count, sides) {
    const player = this.players.get(socketId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };
    const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const total = rolls.reduce((a, b) => a + b, 0);
    return { success: true, playerName: player.name, rolls, total, count, sides, timestamp: new Date().toISOString() };
  }

  setCurrentStep(index) {
    this.currentStepIndex = index;
    return { success: true };
  }

  validateStep(index) {
    if (!this.validatedStepIndices.includes(index)) {
      this.validatedStepIndices.push(index);
    }
    return { success: true };
  }

  updatePlayerStats(targetSocketId, stats) {
    const player = this.players.get(targetSocketId);
    if (!player || !player.selectedCharacter) {
      return { success: false, error: 'Joueur ou personnage introuvable.' };
    }
    const character = this.getCharacterById(player.selectedCharacter);
    if (!character) return { success: false, error: 'Personnage introuvable.' };
    character.stats = { ...character.stats, ...stats };
    return { success: true };
  }

  updatePlayerInventory(targetSocketId, inventory) {
    const player = this.players.get(targetSocketId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };
    player.inventory = inventory;
    return { success: true };
  }

  // ─── State Getters ────────────────────────────────

  getGMState() {
    const playersData = [];
    for (const [socketId, player] of this.players) {
      const charData = player.selectedCharacter
        ? this.getCharacterById(player.selectedCharacter)
        : null;

      playersData.push({
        socketId,
        name: player.name,
        connected: player.connected,
        selectedCharacter: charData ? {
          id: charData.id,
          name: charData.name,
          title: charData.title,
          icon: charData.icon,
          stats: charData.stats,
          visibleSkills: charData.visibleSkills,
          hiddenSkills: charData.hiddenSkills,
          specialNote: charData.specialNote,
          color: charData.color
        } : null,
        hasSelected: !!player.selectedCharacter,
        selectionValidated: player.selectionValidated,
        revealedSkills: player.revealedSkills,
        cardsDealt: player.cards.length,
        flippedCount: player.flippedCards.length,
        messages: player.messages,
        inventory: player.inventory
      });
    }

    const globalCardsData = this.globalPool.map(charId => {
      const c = this.getCharacterById(charId);
      return c ? this.getCardPreview(c) : null;
    }).filter(Boolean);

    return {
      phase: this.phase,
      players: playersData,
      globalCards: globalCardsData,
      totalCharacters: this.allCharacters.length,
      allSelected: this.allPlayersSelected(),
      currentStepIndex: this.currentStepIndex,
      validatedStepIndices: this.validatedStepIndices
    };
  }

  getPlayerState(socketId) {
    const player = this.players.get(socketId);
    if (!player) return null;

    let cards = [];
    if (this.phase === PHASES.CARD_SELECTION || this.phase === PHASES.PLAYING) {
      cards = player.cards.map(charId => {
        const isFlipped = player.flippedCards.includes(charId);
        const isSelected = player.selectedCharacter === charId;
        const character = this.getCharacterById(charId);

        if (isFlipped) {
          return { id: charId, flipped: true, selected: isSelected, ...this.getCardPreview(character) };
        }
        return { id: charId, flipped: false, selected: false };
      });
    }

    let characterFull = null;
    if (this.phase === PHASES.PLAYING && player.selectedCharacter) {
      const character = this.getCharacterById(player.selectedCharacter);
      characterFull = {
        ...character,
        revealedHiddenSkills: character.hiddenSkills.filter(s => player.revealedSkills.includes(s.id)),
        hiddenSkillCount: character.hiddenSkills.length,
        revealedCount: player.revealedSkills.length
      };
    }

    const globalCardsData = this.globalPool.map(charId => {
      const c = this.getCharacterById(charId);
      return c ? this.getCardPreview(c) : null;
    }).filter(Boolean);

    return {
      phase: this.phase,
      name: player.name,
      cards,
      hasSelected: !!player.selectedCharacter,
      selectionValidated: player.selectionValidated,
      globalCards: globalCardsData,
      character: characterFull,
      messages: player.messages,
      inventory: player.inventory
    };
  }

  // ─── Helpers ──────────────────────────────────────

  allPlayersSelected() {
    if (this.players.size === 0) return false;
    for (const [, player] of this.players) {
      if (player.connected && !player.selectionValidated) return false;
    }
    return true;
  }

  getConnectedPlayerCount() {
    let count = 0;
    for (const [, player] of this.players) {
      if (player.connected) count++;
    }
    return count;
  }

  getCharacterById(id) {
    return this.allCharacters.find(c => c.id === id);
  }

  getCardPreview(character) {
    return {
      id: character.id,
      name: character.name,
      title: character.title,
      icon: character.icon,
      visibleSkills: character.visibleSkills,
      color: character.color,
      backstory: character.backstory
    };
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}

module.exports = { GameEngine, PHASES };
