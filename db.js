// ============================================
// db.js — Connexion MongoDB
// ============================================
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/rpmanager';

async function connectDB() {
  await mongoose.connect(MONGODB_URI);
  console.log(`[DB] Connecté à MongoDB — ${MONGODB_URI}`);
}

module.exports = { connectDB, MONGODB_URI };
