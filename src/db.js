const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'somnohub.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
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
        'examen_en_cours','examen_termine','resultat_disponible','consultation_annonce'
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
        'disponible','assigne','chez_patient','maintenance','reserve','hors_service'
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

  seedData(db);
  return db;
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

  // Boîtiers
  const insertBoitier = db.prepare(`
    INSERT INTO boitiers (numero, statut, tracker_gps, lat, lng) VALUES (?, ?, ?, ?, ?)
  `);
  const b01 = insertBoitier.run('SL-B01', 'disponible', 'TRACKER-01', 48.8566, 2.3522).lastInsertRowid;
  const b02 = insertBoitier.run('SL-B02', 'disponible', 'TRACKER-02', 48.8600, 2.3400).lastInsertRowid;
  const b03 = insertBoitier.run('SL-B03', 'disponible', 'TRACKER-03', 48.8650, 2.3600).lastInsertRowid;
  const b04 = insertBoitier.run('SL-B04', 'disponible', 'TRACKER-04', 48.8700, 2.3700).lastInsertRowid;
  const b05 = insertBoitier.run('SL-B05', 'maintenance', 'TRACKER-05', 48.8500, 2.3300).lastInsertRowid;
  const b06 = insertBoitier.run('SL-B06', 'maintenance', 'TRACKER-06', 48.8480, 2.3450).lastInsertRowid;
  const b07 = insertBoitier.run('SL-B07', 'reserve', 'TRACKER-07', 48.8566, 2.3522).lastInsertRowid;
  const b08 = insertBoitier.run('SL-B08', 'hors_service', 'TRACKER-08', 48.8566, 2.3522).lastInsertRowid;
  const b09 = insertBoitier.run('SL-B09', 'disponible', 'TRACKER-09', 48.8620, 2.3580).lastInsertRowid;
  const b10 = insertBoitier.run('SL-B10', 'disponible', 'TRACKER-10', 48.8540, 2.3490).lastInsertRowid;

  // Patients avec adresses parisiennes réelles
  const insertPatient = db.prepare(`
    INSERT INTO patients (medecin_id, nom, prenom, telephone, adresse, lat, lng, score_stop_bang, statut, date_resultat, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];

  const p1 = insertPatient.run(med1Id, 'Bernard', 'Michel', '0612345601', '15 Rue de Rivoli, 75001 Paris', 48.8559, 2.3571, 6, 'prescrit', null, today).lastInsertRowid;
  const p2 = insertPatient.run(med1Id, 'Moreau', 'Isabelle', '0612345602', '28 Avenue des Champs-Élysées, 75008 Paris', 48.8698, 2.3078, 5, 'livraison_prevue', null, today).lastInsertRowid;
  const p3 = insertPatient.run(med1Id, 'Leroy', 'Thomas', '0612345603', '7 Rue de la Paix, 75002 Paris', 48.8697, 2.3310, 7, 'examen_en_cours', null, yesterday).lastInsertRowid;
  const p4 = insertPatient.run(med1Id, 'Simon', 'Marie', '0612345604', '42 Boulevard Saint-Germain, 75005 Paris', 48.8534, 2.3488, 4, 'examen_termine', null, twoDaysAgo).lastInsertRowid;
  const p5 = insertPatient.run(med1Id, 'Laurent', 'Jean', '0612345605', '5 Place de la Bastille, 75004 Paris', 48.8533, 2.3692, 8, 'resultat_disponible', twoDaysAgo, twoDaysAgo).lastInsertRowid;
  const p6 = insertPatient.run(med2Id, 'Petit', 'Anne', '0612345606', '18 Rue Montorgueil, 75001 Paris', 48.8635, 2.3474, 3, 'consultation_annonce', new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0], new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]).lastInsertRowid;
  const p7 = insertPatient.run(med2Id, 'Roux', 'François', '0612345607', '33 Avenue de l\'Opéra, 75001 Paris', 48.8680, 2.3315, 5, 'livraison_prevue', null, today).lastInsertRowid;
  const p8 = insertPatient.run(med2Id, 'Blanc', 'Nathalie', '0612345608', '11 Rue du Temple, 75004 Paris', 48.8611, 2.3529, 6, 'examen_en_cours', null, yesterday).lastInsertRowid;
  const p9 = insertPatient.run(med1Id, 'Garnier', 'Paul', '0612345609', '55 Rue de Bretagne, 75003 Paris', 48.8637, 2.3601, 7, 'resultat_disponible', new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0], new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0]).lastInsertRowid;
  const p10 = insertPatient.run(med2Id, 'Faure', 'Christine', '0612345610', '8 Passage Jouffroy, 75009 Paris', 48.8736, 2.3467, 4, 'prescrit', null, today).lastInsertRowid;

  // Assigner les boîtiers aux patients actifs
  const updateBoitier = db.prepare('UPDATE boitiers SET patient_id = ?, statut = ?, lat = ?, lng = ? WHERE id = ?');
  const assignBoitierPatient = db.prepare('UPDATE boitiers SET patient_id = ?, statut = ?, lat = ?, lng = ?, derniere_action = CURRENT_TIMESTAMP WHERE id = ?');

  // p2 livraison_prevue → boitier assigné
  db.prepare('UPDATE boitiers SET patient_id = ?, statut = ?, derniere_action = CURRENT_TIMESTAMP WHERE id = ?').run(p2, 'assigne', b02);

  // p3 examen_en_cours → boitier chez patient
  assignBoitierPatient.run(p3, 'chez_patient', 48.8697, 2.3310, b03);

  // p7 livraison_prevue → boitier assigné
  db.prepare('UPDATE boitiers SET patient_id = ?, statut = ?, derniere_action = CURRENT_TIMESTAMP WHERE id = ?').run(p7, 'assigne', b09);

  // p8 examen_en_cours → boitier chez patient
  assignBoitierPatient.run(p8, 'chez_patient', 48.8611, 2.3529, b10);

  // Historiques
  const insertHisto = db.prepare(`
    INSERT INTO historique_patient (patient_id, statut, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)
  `);

  insertHisto.run(p1, 'prescrit', 'Prescription créée par Dr. Martin', med1Id, today + ' 09:15:00');
  insertHisto.run(p2, 'prescrit', 'Prescription créée par Dr. Martin', med1Id, today + ' 10:30:00');
  insertHisto.run(p2, 'livraison_prevue', 'Boîtier SL-B02 assigné', adminId, today + ' 10:31:00');
  insertHisto.run(p3, 'prescrit', 'Prescription créée par Dr. Martin', med1Id, yesterday + ' 08:45:00');
  insertHisto.run(p3, 'livraison_prevue', 'Boîtier SL-B03 assigné', adminId, yesterday + ' 09:00:00');
  insertHisto.run(p3, 'livraison_effectuee', 'Boîtier déposé chez le patient', livreurId, yesterday + ' 18:23:00');
  insertHisto.run(p3, 'examen_en_cours', 'Examen démarré', livreurId, yesterday + ' 18:23:00');
  insertHisto.run(p4, 'prescrit', 'Prescription créée', med1Id, twoDaysAgo + ' 14:00:00');
  insertHisto.run(p4, 'livraison_prevue', 'Boîtier assigné', adminId, twoDaysAgo + ' 14:05:00');
  insertHisto.run(p4, 'livraison_effectuee', 'Boîtier déposé chez le patient', livreurId, twoDaysAgo + ' 18:10:00');
  insertHisto.run(p4, 'examen_en_cours', 'Examen démarré', livreurId, twoDaysAgo + ' 18:10:00');
  insertHisto.run(p4, 'examen_termine', 'Boîtier récupéré, données en analyse', livreurId, yesterday + ' 07:55:00');
  insertHisto.run(p5, 'resultat_disponible', 'Résultat disponible — IAH: 22, SAOS modéré', adminId, twoDaysAgo + ' 16:00:00');
  insertHisto.run(p6, 'consultation_annonce', 'Consultation réalisée', med2Id, new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0] + ' 11:00:00');

  // Tournées du jour
  const insertStop = db.prepare(`
    INSERT INTO tournee_stops (date, type, patient_id, boitier_id, action, ordre) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertStop.run(today, 'soir', p2, b02, 'livrer', 1);
  insertStop.run(today, 'soir', p7, b09, 'livrer', 2);
  insertStop.run(today, 'matin', p3, b03, 'recuperer', 1);
  insertStop.run(today, 'matin', p8, b10, 'recuperer', 2);

  // Alertes
  const insertAlerte = db.prepare(`
    INSERT INTO alertes (type, message, boitier_id, patient_id) VALUES (?, ?, ?, ?)
  `);
  insertAlerte.run('stock_critique', 'Seulement 5 boîtiers disponibles au local', null, null);
  insertAlerte.run('boitier_immobile', 'Boîtier SL-B03 chez le patient Leroy depuis +24h', b03, p3);
  insertAlerte.run('maintenance_longue', 'Boîtier SL-B05 en maintenance depuis +24h', b05, null);

  // Revenus historiques (30 derniers jours)
  const insertRevenu = db.prepare(`
    INSERT INTO revenus (medecin_id, patient_id, montant, date) VALUES (?, ?, ?, ?)
  `);
  const tarif = 150;
  for (let i = 30; i >= 1; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
    const nb = Math.floor(Math.random() * 3);
    for (let j = 0; j < nb; j++) {
      const mId = j % 2 === 0 ? med1Id : med2Id;
      insertRevenu.run(mId, p6, tarif, d);
    }
  }
  insertRevenu.run(med1Id, p5, tarif, twoDaysAgo);
  insertRevenu.run(med1Id, p9, tarif, new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]);

  // SMS logs
  const insertSMS = db.prepare(`
    INSERT INTO sms_log (patient_id, type, message, statut) VALUES (?, ?, ?, ?)
  `);
  insertSMS.run(p2, 'prescription', `Bonjour Isabelle, votre médecin a prescrit une polygraphie du sommeil. Notre livreur passera ce soir entre 17h et 19h. Merci d'être disponible.`, 'envoye');
  insertSMS.run(p3, 'prescription', `Bonjour Thomas, votre médecin a prescrit une polygraphie du sommeil. Notre livreur passera ce soir entre 17h et 19h. Merci d'être disponible.`, 'envoye');
  insertSMS.run(p3, 'rappel_recuperation', `Bonjour Thomas, notre livreur passera ce matin entre 7h et 9h récupérer votre boîtier de polygraphie. Merci de le préparer.`, 'envoye');

  console.log('✅ Données de démonstration chargées');
  console.log('');
  console.log('Comptes disponibles :');
  console.log('  admin@somnohub.fr      / Admin123!');
  console.log('  dr.martin@somnohub.fr  / Medecin123!');
  console.log('  dr.dupont@somnohub.fr  / Medecin123!');
  console.log('  livreur@somnohub.fr    / Livreur123!');
  console.log('  assistante@somnohub.fr / Assist123!');
}

module.exports = { getDb, initDb };
