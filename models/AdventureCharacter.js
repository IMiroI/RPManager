// ============================================
// models/AdventureCharacter.js — Personnage persistant d'un joueur sur une Aventure
// ============================================
const mongoose = require('mongoose');

const journalEntrySchema = new mongoose.Schema({
  id: { type: String, required: true },
  text: { type: String, default: '' },
  authorRole: { type: String, enum: ['player', 'gm'], required: true },
  createdAt: { type: Date, default: Date.now },
  // Document texte (.txt) facultatif attaché par le MJ (ex: une lettre trouvée) — voir models/Media.js
  // kind:'document'. Une entrée a toujours au moins l'un des deux : text ou documentMediaId.
  documentMediaId: { type: String, default: null },
  documentName: { type: String, default: '' }
}, { _id: false });

const inventoryDocumentSchema = new mongoose.Schema({
  id: { type: String, required: true },
  mediaId: { type: String, required: true },
  name: { type: String, default: 'Document' }
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
  icon: { type: String, default: '' },
  tokenMediaId: { type: String, default: null },
  tokenColor: { type: String, default: '#c9a227' }, // couleur du contour du token sur la carte
  ko: { type: Boolean, default: false }, // KO/mort — affiche une croix rouge sur le token, géré par le MJ
  backstory: { type: String, default: '' },
  skills: { type: [skillSchema], default: [] },
  // Statistiques libres : clés définies par le MJ (roleplay.statDefinitions), valeurs numériques.
  stats: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Modificateurs facultatifs par statistique (même clés que `stats`) — voir Roleplay.statModifiersEnabled.
  statModifiers: { type: mongoose.Schema.Types.Mixed, default: {} },
  inventory: { type: [String], default: [] },
  // Documents texte déposés par le MJ dans l'inventaire (distincts des objets en texte libre
  // ci-dessus) — ouverts en popup côté joueur via models/Media.js kind:'document'.
  inventoryDocuments: { type: [inventoryDocumentSchema], default: [] },
  journal: { type: [journalEntrySchema], default: [] },
  messages: { type: [privateMessageSchema], default: [] }
// minimize:false — sans ça, Mongoose supprime silencieusement `stats` du document
// quand une aventure n'a aucune statistique configurée (objet vide {}), ce qui ferait
// planter les futures écritures sur doc.stats[key] (doc.stats deviendrait undefined).
}, { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }, minimize: false });

// Non-unique : un joueur peut créer plusieurs personnages sur une même aventure.
adventureCharacterSchema.index({ roleplay: 1, player: 1 });

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
