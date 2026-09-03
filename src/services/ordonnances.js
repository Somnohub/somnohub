const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Les ordonnances sont des documents de santé : elles sont écrites à côté de la
// base, sur le volume persistant, et JAMAIS sous public/ — aucune URL directe
// ne doit permettre d'y accéder. La lecture passe par une route authentifiée.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'somnohub.db');
const DIR = path.join(path.dirname(DB_PATH), 'ordonnances');

const TAILLE_MAX = 5 * 1024 * 1024; // 5 Mo

// On identifie le type par la signature du fichier, pas par ce que déclare le
// client : une extension ou un content-type sont trivialement falsifiables.
const SIGNATURES = [
  { mime: 'application/pdf', ext: 'pdf', test: b => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg',      ext: 'jpg', test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/png',       ext: 'png', test: b => b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])) },
  { mime: 'image/heic',      ext: 'heic', test: b => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp'
                                                     && ['heic','heix','hevc','mif1'].includes(b.slice(8, 12).toString('latin1')) },
];

function dossier() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  return DIR;
}

function typeReconnu(buf) {
  return SIGNATURES.find(s => { try { return s.test(buf); } catch (e) { return false; } }) || null;
}

function nouveauJeton() {
  return crypto.randomBytes(24).toString('hex');
}

function enregistrer(numero, buf) {
  const type = typeReconnu(buf);
  if (!type) return { erreur: 'Format non accepté — envoyez un PDF ou une photo (JPEG, PNG, HEIC).' };
  if (buf.length > TAILLE_MAX) return { erreur: 'Fichier trop volumineux — 5 Mo maximum.' };

  const nom = `demande-${numero}-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(dossier(), nom), buf, { mode: 0o600 });
  return { nom, mime: type.mime };
}

// Le nom vient de la base, mais on refuse par principe tout chemin qui
// sortirait du dossier prévu.
function chemin(nom) {
  if (!nom || nom.includes('/') || nom.includes('\\') || nom.includes('..')) return null;
  const p = path.join(DIR, nom);
  return fs.existsSync(p) ? p : null;
}

function supprimer(nom) {
  const p = chemin(nom);
  if (p) { try { fs.unlinkSync(p); } catch (e) {} }
}

module.exports = { enregistrer, chemin, supprimer, nouveauJeton, TAILLE_MAX, DIR };
