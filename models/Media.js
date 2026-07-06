// ============================================
// models/Media.js — Fichier média uploadé pour une Aventure (carte/musique)
// ============================================
const mongoose = require('mongoose');

const tokenPositionSchema = new mongoose.Schema({
  // characterId contient soit l'id d'un AdventureCharacter (kind:'character'), soit l'id d'un PNJ (kind:'npc')
  characterId: { type: String, required: true },
  kind: { type: String, enum: ['character', 'npc'], default: 'character' },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  rotation: { type: Number, default: 0 }
}, { _id: false });

const mediaSchema = new mongoose.Schema({
  roleplay: { type: mongoose.Schema.Types.ObjectId, ref: 'Roleplay', required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['map', 'music', 'token'], required: true },
  originalName: { type: String, required: true },
  filename: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  chapterId: { type: String, default: null },
  // Positions des tokens des personnages, uniquement pertinent pour kind==='map'
  tokenPositions: { type: [tokenPositionSchema], default: [] }
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
