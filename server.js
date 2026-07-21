require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb, getDb, closeDb } = require('./src/db');
const { startScheduler } = require('./src/services/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/medecin', require('./src/routes/medecin'));
app.use('/api/livreur', require('./src/routes/livreur'));
app.use('/api/assistante', require('./src/routes/assistante'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/demandes', require('./src/routes/demandes'));

// SPA fallbacks
app.get('/medecin', (req, res) => res.sendFile(path.join(__dirname, 'public/medecin/index.html')));
app.get('/livreur', (req, res) => res.sendFile(path.join(__dirname, 'public/livreur/index.html')));
app.get('/assistante', (req, res) => res.sendFile(path.join(__dirname, 'public/assistante/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/demande', (req, res) => res.sendFile(path.join(__dirname, 'public/demande/index.html')));

// Pages SEO (contenu longue traîne)
app.get('/apnee-du-sommeil', (req, res) => res.sendFile(path.join(__dirname, 'public/apnee-du-sommeil/index.html')));
app.get('/polygraphie-ventilatoire', (req, res) => res.sendFile(path.join(__dirname, 'public/polygraphie-ventilatoire/index.html')));
app.get('/remboursement-polygraphie', (req, res) => res.sendFile(path.join(__dirname, 'public/remboursement-polygraphie/index.html')));
app.get('/ronflements', (req, res) => res.sendFile(path.join(__dirname, 'public/ronflements/index.html')));
app.get('/traitement-apnee-du-sommeil', (req, res) => res.sendFile(path.join(__dirname, 'public/traitement-apnee-du-sommeil/index.html')));
app.get('/score-stop-bang', (req, res) => res.sendFile(path.join(__dirname, 'public/score-stop-bang/index.html')));
app.get('/apnee-du-sommeil-fatigue', (req, res) => res.sendFile(path.join(__dirname, 'public/apnee-du-sommeil-fatigue/index.html')));
app.get('/apnee-du-sommeil-femme', (req, res) => res.sendFile(path.join(__dirname, 'public/apnee-du-sommeil-femme/index.html')));

// ── DIAGNOSTIC PERSISTANCE VOLUME ───────────────────────
// Écrit un fichier témoin et relit le précédent : si le témoin ne survit
// pas au redémarrage, c'est le volume Railway qui ne persiste pas.
(function diagnosticVolume() {
  const fs = require('fs');
  const p = require('path');
  const dir = p.dirname(process.env.DB_PATH || p.join(__dirname, 'somnohub.db'));
  const marker = p.join(dir, '.persist-marker');
  try {
    if (fs.existsSync(marker)) {
      console.log(`[DIAG] Témoin précédent : ${fs.readFileSync(marker, 'utf8')}`);
    } else {
      console.log('[DIAG] Témoin précédent : AUCUN (le fichier a disparu)');
    }
    fs.writeFileSync(marker, new Date().toISOString());
    const files = fs.readdirSync(dir).map(f => {
      try { return `${f} (${fs.statSync(p.join(dir, f)).size}o)`; } catch (e) { return f; }
    });
    console.log(`[DIAG] Contenu de ${dir} : ${files.join(', ') || '(vide)'}`);
  } catch (e) {
    console.log(`[DIAG] Erreur accès volume : ${e.message}`);
  }
})();

// Démarrage
initDb();
startScheduler();

app.listen(PORT, () => {
  const dbPath = process.env.DB_PATH || require('path').join(__dirname, 'somnohub.db');
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         SOMNOHUB — Démarré              ║');
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  DB_PATH = ${dbPath}`);
  console.log(`  PERSISTANT = ${process.env.DB_PATH ? 'OUI (volume Railway)' : 'NON — données éphémères !'}`);
  try {
    const nbPatients = getDb().prepare('SELECT COUNT(*) as n FROM patients').get().n;
    console.log(`  PATIENTS EN BASE = ${nbPatients}`);
  } catch (e) {}
  console.log('');
  console.log('  /           → Page de connexion');
  console.log('  /medecin    → Interface médecin');
  console.log('  /livreur    → Interface livreur (mobile)');
  console.log('  /assistante → Interface assistante');
  console.log('  /admin      → Interface admin');
  console.log('');
});

// Fermeture propre de la base quand Railway arrête le container
function arretPropre() {
  console.log('[Arrêt] Fermeture de la base de données...');
  closeDb();
  process.exit(0);
}
process.on('SIGTERM', arretPropre);
process.on('SIGINT', arretPropre);
