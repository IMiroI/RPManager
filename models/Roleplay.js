// ============================================
// models/Roleplay.js — Roleplay créé par un utilisateur
// ============================================
const mongoose = require('mongoose');

// Statistiques proposées par défaut à la création d'une Aventure — le MJ peut en retirer
// ou en ajouter de nouvelles (entièrement personnalisées) depuis l'éditeur.
const DEFAULT_STAT_DEFINITIONS = [
  { key: 'pointsDeVie', label: 'Points de vie' },
  { key: 'force', label: 'Force' },
  { key: 'persuasion', label: 'Persuasion' },
  { key: 'perception', label: 'Perception' },
  { key: 'dexterite', label: 'Dextérité' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'sagesse', label: 'Sagesse' },
  { key: 'constitution', label: 'Constitution' },
  { key: 'charisme', label: 'Charisme' }
];

const statDefinitionSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true }
}, { _id: false });

const roleplaySchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['oneshot', 'aventure'], default: 'oneshot' },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  themeColor: { type: String, default: '#8B6914' },
  maxPlayers: { type: Number, default: 10 },
  characters: { type: [mongoose.Schema.Types.Mixed], default: [] },
  scenarioSteps: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // ─── Champs spécifiques au type "aventure" ──────────
  inviteCode: { type: String, unique: true, sparse: true, index: true },
  npcs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  chapters: { type: [mongoose.Schema.Types.Mixed], default: [] },
  pointBudget: { type: Number, default: 30 },
  statDefinitions: { type: [statDefinitionSchema], default: () => DEFAULT_STAT_DEFINITIONS.map(d => ({ ...d })) },
  members: { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [], index: true }
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } });

roleplaySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.owner;
    delete ret.members;
    return ret;
  }
});

module.exports = mongoose.model('Roleplay', roleplaySchema);
module.exports.DEFAULT_STAT_DEFINITIONS = DEFAULT_STAT_DEFINITIONS;
