const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');

const MAX_BACKUPS = 7; // on conserve les 7 sauvegardes les plus récentes

// Le dossier de sauvegarde est placé à côté du fichier de base, donc sur le
// même volume persistant Railway (getDb().name = chemin réel du .db).
function backupDir() {
  return path.join(path.dirname(getDb().name), 'backups');
}

// Sauvegarde en ligne (API better-sqlite3, sans corruption même si l'app écrit).
async function backupNow() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `somnohub-${stamp}.db`);
  await getDb().backup(dest);

  // Rotation : on supprime les plus anciennes au-delà de MAX_BACKUPS
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  while (files.length > MAX_BACKUPS) {
    try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) {}
  }

  return { fichier: path.basename(dest), taille: fs.statSync(dest).size };
}

function dernieresSauvegardes() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { fichier: f, taille: st.size, date: st.mtime.toISOString() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { backupNow, dernieresSauvegardes };
