// ============================================
// uploadStorage.js — Configuration multer pour l'upload de médias d'Aventure
// ============================================
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const multer = require('multer');

const UPLOAD_ROOT = path.join(__dirname, 'uploads');

const MAP_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const MUSIC_MIME_EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav' };
// PNG uniquement — les sprites profitent de la transparence pour s'incruster dans le décor.
const SPRITE_MIME_EXT = { 'image/png': '.png' };

function makeStorage(mimeExt) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = mimeExt[file.mimetype] || '';
      cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext}`);
    }
  });
}

function makeFileFilter(mimeExt) {
  return (req, file, cb) => {
    if (!mimeExt[file.mimetype]) return cb(new Error('Type de fichier non autorisé'));
    cb(null, true);
  };
}

const uploadMap = multer({
  storage: makeStorage(MAP_MIME_EXT),
  fileFilter: makeFileFilter(MAP_MIME_EXT),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const uploadMusic = multer({
  storage: makeStorage(MUSIC_MIME_EXT),
  fileFilter: makeFileFilter(MUSIC_MIME_EXT),
  limits: { fileSize: 30 * 1024 * 1024 }
});

const uploadToken = multer({
  storage: makeStorage(MAP_MIME_EXT),
  fileFilter: makeFileFilter(MAP_MIME_EXT),
  limits: { fileSize: 3 * 1024 * 1024 }
});

const uploadSprite = multer({
  storage: makeStorage(SPRITE_MIME_EXT),
  fileFilter: makeFileFilter(SPRITE_MIME_EXT),
  limits: { fileSize: 3 * 1024 * 1024 }
});

module.exports = { uploadMap, uploadMusic, uploadToken, uploadSprite, UPLOAD_ROOT };
