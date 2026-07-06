// ============================================
// models/AdventureCharacter.js — Personnage persistant d'un joueur sur une Aventure
// ============================================
const mongoose = require('mongoose');

const journalEntrySchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: { type: String, required: true },
  authorRole: { type: String, enum: ['player', 'gm'], required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const skillSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  // Taille du second dé lancé pour cette compétence (1d100 + 1dDiceSides)
  diceSides: { type: Number, default: 6 }
}, { _id: false });

const privateMessageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: { type: String, required: true },
  from: { type: String, enum: ['player', 'gm'], required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const adventureCharacterSchema = new mongoose.Schema({
  roleplay: { type: mongoose.Schema.Types.ObjectId, ref: 'Roleplay', required: true, index: true },
  player: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  icon: { type: String, default: '❓' },
  tokenMediaId: { type: String, default: null },
  backstory: { type: String, default: '' },
  skills: { type: [skillSchema], default: [] },
  // Statistiques libres : clés définies par le MJ (roleplay.statDefinitions), valeurs numériques.
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  inventory: { type: [String], default: [] },
  journal: { type: [journalEntrySchema], default: [] },
  messages: { type: [privateMessageSchema], default: [] }
// minimize:false — sans ça, Mongoose supprime silencieusement `stats` du document
// quand une aventure n'a aucune statistique configurée (objet vide {}), ce qui ferait
// planter les futures écritures sur doc.stats[key] (doc.stats deviendrait undefined).
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }, minimize: false });

adventureCharacterSchema.index({ roleplay: 1, player: 1 }, { unique: true });

adventureCharacterSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('AdventureCharacter', adventureCharacterSchema);
