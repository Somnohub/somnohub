const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'somnohub.db');

// Créer le dossier parent si nécessaire (volume persistant Railway)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    // journal_mode = DELETE + synchronous = FULL :
    // chaque commit est fsync directement dans le fichier sur le volume.
    // Évite la perte de données quand Railway tue le container (le WAL n'était
    // pas checkpointé à temps → transactions perdues au redémarrage).
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) {
    try { db.close(); } catch (e) {}
    db = null;
  }
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'medecin', 'livreur', 'assistante')),
      actif INTEGER DEFAULT 1,
      derniere_connexion DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medecin_id INTEGER NOT NULL,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      telephone TEXT NOT NULL,
      adresse TEXT NOT NULL,
      lat REAL DEFAULT 48.8566,
      lng REAL DEFAULT 2.3522,
      score_stop_bang INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'prescrit' CHECK(statut IN (
        'prescrit','livraison_prevue','livraison_effectuee',
        'examen_en_cours','en_cours_d_analyse','examen_termine','resultat_disponible','consultation_annonce'
      )),
      date_resultat DATETIME,
      suivi_3mois_envoye INTEGER DEFAULT 0,
      suivi_6mois_envoye INTEGER DEFAULT 0,
      suivi_1an_envoye INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (medecin_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS boitiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT UNIQUE NOT NULL,
      statut TEXT DEFAULT 'disponible' CHECK(statut IN (
        'disponible','assigne','chez_patient','en_analyse','maintenance','reserve','hors_service'
      )),
      tracker_gps TEXT,
      lat REAL DEFAULT 48.8566,
      lng REAL DEFAULT 2.3522,
      patient_id INTEGER,
      derniere_action DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS historique_patient (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      statut TEXT NOT NULL,
      note TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tournee_stops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('matin','soir')),
      patient_id INTEGER NOT NULL,
      boitier_id INTEGER,
      action TEXT NOT NULL CHECK(action IN ('livrer','recuperer')),
      ordre INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'en_attente' CHECK(statut IN ('en_attente','complete','echec')),
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id),
      FOREIGN KEY (boitier_id) REFERENCES boitiers(id)
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      statut TEXT DEFAULT 'envoye',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS alertes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      boitier_id INTEGER,
      patient_id INTEGER,
      lu INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (boitier_id) REFERENCES boitiers(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS tournees_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      nb_arrets INTEGER DEFAULT 0,
      distance_km REAL,
      duree_min INTEGER,
      livreur_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (livreur_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS demandes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('medecin','patient')),
      patient_nom TEXT NOT NULL,
      patient_prenom TEXT NOT NULL,
      date_naissance TEXT,
      telephone TEXT NOT NULL,
      adresse TEXT NOT NULL,
      medecin_nom TEXT,
      medecin_rpps TEXT,
      indication TEXT,
      couverture TEXT,
      mutuelle_nom TEXT,
      lat REAL,
      lng REAL,
      ordonnance_mode TEXT DEFAULT 'a_la_livraison' CHECK(ordonnance_mode IN ('transmise','a_la_livraison')),
      ordonnance_presente INTEGER DEFAULT 0,
      consentement INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'recue' CHECK(statut IN ('recue','validee','programmee','realisee','cr_signe','cloturee','refusee')),
      motif_refus TEXT,
      patient_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );

    CREATE TABLE IF NOT EXISTS revenus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medecin_id INTEGER NOT NULL,
      patient_id INTEGER NOT NULL,
      montant REAL DEFAULT 150.0,
      date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (medecin_id) REFERENCES users(id),
      FOREIGN KEY (patient_id) REFERENCES patients(id)
    );
  `);

  migrate(db);
  seedData(db);
  return db;
}

// Migrations idempotentes : ajoute les colonnes manquantes sur une base existante.
// ALTER TABLE ADD COLUMN échoue si la colonne existe déjà → on ignore l'erreur.
function migrate(db) {
  const ajouts = [
    `ALTER TABLE demandes ADD COLUMN lat REAL`,
    `ALTER TABLE demandes ADD COLUMN lng REAL`,
    `ALTER TABLE demandes ADD COLUMN couverture TEXT`,
    `ALTER TABLE demandes ADD COLUMN mutuelle_nom TEXT`,
  ];
  for (const sql of ajouts) {
    try { db.exec(sql); } catch (e) { /* colonne déjà présente */ }
  }
}

function seedData(db) {
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@somnohub.fr');
  if (existingAdmin) return;

  console.log('Initialisation des données de démonstration...');

  // Comptes utilisateurs
  const insertUser = db.prepare(`
    INSERT INTO users (nom, prenom, email, password_hash, role) VALUES (?, ?, ?, ?, ?)
  `);

  const adminId = insertUser.run('Admin', 'SomnoHub', 'admin@somnohub.fr', '$2a$10$RH.zoOLbdbxvU2pMrtJyZ.5O9SK94eEQzvdK8DglZP11mLGe4M0lS', 'admin').lastInsertRowid;
  const med1Id = insertUser.run('Martin', 'Sophie', 'dr.martin@somnohub.fr', '$2a$10$5xZcqK.JGP6MtOmnqdR21ur2fdxJuocf/xE6gZnnQri5oL.fjhEuO', 'medecin').lastInsertRowid;
  const med2Id = insertUser.run('Dupont', 'Pierre', 'dr.dupont@somnohub.fr', '$2a$10$i4RHbDJ1PriW7UfuIECvZuX2zP5FC/WGU/qWqVfBN3uSb17kWRuK2', 'medecin').lastInsertRowid;
  const livreurId = insertUser.run('Leblanc', 'Marc', 'livreur@somnohub.fr', '$2a$10$4WSmXiYAU1GKmIl.huvKGemi7HgRFV0EFhtWOraVTQq3PPmw/0Db2', 'livreur').lastInsertRowid;
  insertUser.run('Rousseau', 'Claire', 'assistante@somnohub.fr', '$2a$10$v3zmRu.8liumWWZANBndHuhc/7EJUPwI5cAFY6qulb0clh81CgUaO', 'assistante');

  // Boîtiers — tous disponibles, prêts à l'emploi
  const insertBoitier = db.prepare(`
    INSERT INTO boitiers (numero, statut, lat, lng) VALUES (?, 'disponible', ?, ?)
  `);
  insertBoitier.run('SL-B01', 48.8566, 2.3522);
  insertBoitier.run('SL-B02', 48.8566, 2.3522);
  insertBoitier.run('SL-B03', 48.8566, 2.3522);
  insertBoitier.run('SL-B04', 48.8566, 2.3522);
  insertBoitier.run('SL-B05', 48.8566, 2.3522);
  insertBoitier.run('SL-B06', 48.8566, 2.3522);
  insertBoitier.run('SL-B07', 48.8566, 2.3522);
  insertBoitier.run('SL-B08', 48.8566, 2.3522);
  insertBoitier.run('SL-B09', 48.8566, 2.3522);
  insertBoitier.run('SL-B10', 48.8566, 2.3522);

  console.log('✅ Base initialisée — comptes créés, 10 boîtiers disponibles');
  console.log('');
  console.log('Comptes :');
  console.log('  admin@somnohub.fr      / Lune45!');
  console.log('  dr.martin@somnohub.fr  / Pluie34!');
  console.log('  dr.dupont@somnohub.fr  / Pluie56!');
  console.log('  livreur@somnohub.fr    / Soleil45!');
  console.log('  assistante@somnohub.fr / Pluie12!');
}

module.exports = { getDb, initDb, closeDb };
