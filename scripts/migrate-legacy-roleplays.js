// ============================================
// scripts/migrate-legacy-roleplays.js
// Importe les anciens roleplays (data/roleplays/*.json) vers MongoDB,
// rattachés à un compte utilisateur existant.
//
// Usage: node scripts/migrate-legacy-roleplays.js <username>
// ============================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB } = require('../db');
const User = require('../models/User');
const Roleplay = require('../models/Roleplay');

const DATA_DIR = path.join(__dirname, '..', 'data', 'roleplays');

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: node scripts/migrate-legacy-roleplays.js <username>');
    process.exit(1);
  }

  await connectDB();

  const user = await User.findOne({ username: username.toLowerCase() });
  if (!user) {
    console.error(`Utilisateur "${username}" introuvable. Crée d'abord le compte via /register.`);
    process.exit(1);
  }

  if (!fs.existsSync(DATA_DIR)) {
    console.log('Aucun dossier data/roleplays trouvé, rien à migrer.');
    process.exit(0);
  }

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('Aucun roleplay legacy à migrer.');
    process.exit(0);
  }

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    const doc = await Roleplay.create({
      owner: user._id,
      name: data.name,
      description: data.description || '',
      themeColor: data.themeColor || '#8B6914',
      maxPlayers: data.maxPlayers || 10,
      characters: data.characters || [],
      scenarioSteps: data.scenarioSteps || []
    });
    console.log(`Importé "${data.name}" (${file}) -> ${doc._id} pour ${user.username}`);
  }

  console.log('Migration terminée.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
