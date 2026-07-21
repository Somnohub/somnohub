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

// ── Démarrage ───────────────────────────────────────────
async function demarrer() {
  try {
    await initDb();
    startScheduler();

    app.listen(PORT, () => {
      console.log('');
      console.log('╔══════════════════════════════════════════╗');
      console.log('║         SOMNOHUB — Démarré              ║');
      console.log(`║  http://localhost:${PORT}                    ║`);
      console.log('╚══════════════════════════════════════════╝');
      console.log('');
      const url = process.env.DATABASE_URL || process.env.SCALINGO_POSTGRESQL_URL || '(local)';
      // On n'affiche jamais les identifiants de connexion dans les logs
      console.log(`  BASE = PostgreSQL ${url.replace(/\/\/[^@]*@/, '//***@')}`);
      getDb().prepare('SELECT COUNT(*) as n FROM patients').get()
        .then(r => console.log(`  PATIENTS EN BASE = ${r ? r.n : '?'}`))
        .catch(() => {});
      console.log('');
      console.log('  /           → Page de connexion');
      console.log('  /medecin    → Interface médecin');
      console.log('  /livreur    → Interface livreur (mobile)');
      console.log('  /assistante → Interface assistante');
      console.log('  /admin      → Interface admin');
      console.log('');
    });
  } catch (e) {
    console.error('[Démarrage] Échec de l\'initialisation :', e.message);
    process.exit(1);
  }
}

demarrer();

// Fermeture propre du pool PostgreSQL à l'arrêt du conteneur
async function arretPropre() {
  console.log('[Arrêt] Fermeture du pool PostgreSQL...');
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', arretPropre);
process.on('SIGINT', arretPropre);
