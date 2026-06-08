require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./src/db');
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

// SPA fallbacks
app.get('/medecin', (req, res) => res.sendFile(path.join(__dirname, 'public/medecin/index.html')));
app.get('/livreur', (req, res) => res.sendFile(path.join(__dirname, 'public/livreur/index.html')));
app.get('/assistante', (req, res) => res.sendFile(path.join(__dirname, 'public/assistante/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

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
  console.log(`  PERSISTANT = ${dbPath.startsWith('/app/data') ? 'OUI (volume Railway)' : 'NON — données éphémères !'}`);
  console.log('');
  console.log('  /           → Page de connexion');
  console.log('  /medecin    → Interface médecin');
  console.log('  /livreur    → Interface livreur (mobile)');
  console.log('  /assistante → Interface assistante');
  console.log('  /admin      → Interface admin');
  console.log('');
});
