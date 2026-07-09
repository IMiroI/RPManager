// ============================================
// models/Media.js — Fichier média uploadé pour une Aventure (carte/musique)
// ============================================
const mongoose = require('mongoose');

const tokenPositionSchema = new mongoose.Schema({
  // characterId contient soit l'id d'un AdventureCharacter (kind:'character'), soit l'id d'un PNJ
  // (kind:'npc'), soit un id d'instance généré côté serveur pour un décor posé (kind:'sprite') —
  // plusieurs instances du même sprite peuvent être posées, chacune avec son propre characterId.
  characterId: { type: String, required: true },
  kind: { type: String, enum: ['character', 'npc', 'sprite'], default: 'character' },
  // Média source à afficher, uniquement pour kind==='sprite' (le characterId est un id d'instance,
  // pas l'id du média — il faut donc le référencer séparément).
  spriteMediaId: { type: String, default: null },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  rotation: { type: Number, default: 0 }
}, { _id: false });

// Brouillard de guerre — uniquement pertinent pour kind==='map'. Grille FIXE, propre au brouillard
// et totalement indépendante de la grille tactique des tokens (voir FOG_GRID_COLUMNS côté client) —
// redimensionner la grille des tokens n'a donc plus aucun effet sur le brouillard. On stocke les
// cases RÉVÉLÉES (pas les cases masquées) : ainsi on n'a jamais besoin de connaître le nombre total
// de lignes (dépendant du ratio de l'image) pour représenter "tout masqué", qui est simplement
// l'état par défaut de toute case absente de la liste tant que enabled=true.
const fogSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  revealedCells: { type: [String], default: [] } // "col,row"
}, { _id: false });

const mediaSchema = new mongoose.Schema({
  roleplay: { type: mongoose.Schema.Types.ObjectId, ref: 'Roleplay', required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['map', 'music', 'token', 'sprite', 'document'], required: true },
  originalName: { type: String, required: true },
  filename: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  chapterId: { type: String, default: null },
  // Positions des tokens des personnages, uniquement pertinent pour kind==='map'
  tokenPositions: { type: [tokenPositionSchema], default: [] },
  fog: { type: fogSchema, default: () => ({}) }
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } });

mediaSchema.index({ roleplay: 1, kind: 1 });

mediaSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.owner;
    delete ret.filename;
    return ret;
  }
});

module.exports = mongoose.model('Media', mediaSchema);
