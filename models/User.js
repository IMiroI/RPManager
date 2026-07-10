// ============================================
// models/User.js — Compte utilisateur
// ============================================
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 30 },
  // Absent pour les comptes créés uniquement via SSO VGAMES (aucun mot de passe local).
  passwordHash: { type: String, required: false },
  // Lien vers l'utilisateur VGAMES (id Mongo de VGAMES, string) — présent une fois le compte
  // créé via SSO ou lié manuellement via "Lier mon compte VGAMES".
  vgamesId: { type: String, unique: true, sparse: true, index: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
