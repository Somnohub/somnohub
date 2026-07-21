const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// pg renvoie bigint (COUNT) et numeric (SUM) sous forme de chaînes, pour ne pas
// perdre de précision. SQLite renvoyait des nombres : on restaure ce comportement
// afin de ne casser ni les calculs (taux, moyennes) ni l'affichage côté client.
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));   // int8 / COUNT
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));   // numeric / SUM

// Scalingo expose SCALINGO_POSTGRESQL_URL ; en local on utilise DATABASE_URL.
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.SCALINGO_POSTGRESQL_URL ||
  'postgres://localhost:5432/somnohub';

const estLocal = /localhost|127\.0\.0\.1/.test(CONNECTION_STRING);

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      // Les bases managées (Scalingo) exigent TLS ; en local on s'en passe.
      ssl: estLocal ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (e) => console.error('[DB] Erreur du pool PostgreSQL :', e.message));
  }
  return pool;
}

// ─── Couche de compatibilité ────────────────────────────────────────────────
// Conserve l'API historique `db.prepare(sql).get/all/run(...)` héritée de
// better-sqlite3, mais en asynchrone. Chaque appelant doit donc faire `await`.

// Convertit les placeholders `?` (SQLite) en `$1, $2…` (PostgreSQL).
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// `run()` doit renvoyer l'id inséré (ex-lastInsertRowid) → on ajoute RETURNING id
// aux INSERT qui n'en ont pas déjà un.
function avecReturningId(sql) {
  const s = sql.trim();
  if (/^insert/i.test(s) && !/returning/i.test(s)) {
    return s.replace(/;?\s*$/, '') + ' RETURNING id';
  }
  return s;
}

function prepare(sql) {
  const text = toPg(sql);
  const textRun = avecReturningId(text);
  return {
    async get(...params) {
      const r = await getPool().query(text, params);
      return r.rows[0];
    },
    async all(...params) {
      const r = await getPool().query(text, params);
      return r.rows;
    },
    async run(...params) {
      const r = await getPool().query(textRun, params);
      return {
        lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined,
        changes: r.rowCount,
      };
    },
  };
}

// Exécution directe (DDL, scripts)
async function exec(sql) {
  await getPool().query(sql);
}

// Transaction : remplace `db.transaction(fn)` de better-sqlite3.
// Le callback reçoit un objet exposant la même API prepare/get/all/run,
// mais lié à un client unique (indispensable pour BEGIN/COMMIT).
async function withTransaction(fn) {
  const client = await getPool().connect();
  const tx = {
    prepare(sql) {
      const text = toPg(sql);
      const textRun = avecReturningId(text);
      return {
        async get(...p) { return (await client.query(text, p)).rows[0]; },
        async all(...p) { return (await client.query(text, p)).rows; },
        async run(...p) {
          const r = await client.query(textRun, p);
          return { lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined, changes: r.rowCount };
        },
      };
    },
  };
  try {
    await client.query('BEGIN');
    const res = await fn(tx);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Objet `db` compatible avec le code existant
const db = { prepare, exec, withTransaction };
function getDb() { return db; }

async function closeDb() {
  if (pool) {
    try { await pool.end(); } catch (e) {}
    pool = null;
  }
}

// ─── Schéma ─────────────────────────────────────────────────────────────────

async function initDb() {
  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'medecin', 'livreur', 'assistante')),
      actif INTEGER DEFAULT 1,
      derniere_connexion TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS patients (
      id SERIAL PRIMARY KEY,
      medecin_id INTEGER NOT NULL REFERENCES users(id),
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      telephone TEXT NOT NULL,
      adresse TEXT NOT NULL,
      lat DOUBLE PRECISION DEFAULT 48.8566,
      lng DOUBLE PRECISION DEFAULT 2.3522,
      score_stop_bang INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'prescrit' CHECK(statut IN (
        'prescrit','livraison_prevue','livraison_effectuee',
        'examen_en_cours','en_cours_d_analyse','examen_termine','resultat_disponible','consultation_annonce'
      )),
      date_resultat TIMESTAMPTZ,
      suivi_3mois_envoye INTEGER DEFAULT 0,
      suivi_6mois_envoye INTEGER DEFAULT 0,
      suivi_1an_envoye INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS boitiers (
      id SERIAL PRIMARY KEY,
      numero TEXT UNIQUE NOT NULL,
      statut TEXT DEFAULT 'disponible' CHECK(statut IN (
        'disponible','assigne','chez_patient','en_analyse','maintenance','reserve','hors_service'
      )),
      tracker_gps TEXT,
      lat DOUBLE PRECISION DEFAULT 48.8566,
      lng DOUBLE PRECISION DEFAULT 2.3522,
      patient_id INTEGER REFERENCES patients(id),
      derniere_action TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS historique_patient (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      statut TEXT NOT NULL,
      note TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tournee_stops (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('matin','soir')),
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      boitier_id INTEGER REFERENCES boitiers(id),
      action TEXT NOT NULL CHECK(action IN ('livrer','recuperer')),
      ordre INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'en_attente' CHECK(statut IN ('en_attente','complete','echec')),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id SERIAL PRIMARY KEY,
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      statut TEXT DEFAULT 'envoye',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alertes (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      boitier_id INTEGER REFERENCES boitiers(id),
      patient_id INTEGER REFERENCES patients(id),
      lu INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tournees_log (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      nb_arrets INTEGER DEFAULT 0,
      distance_km DOUBLE PRECISION,
      duree_min INTEGER,
      livreur_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demandes (
      id SERIAL PRIMARY KEY,
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
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      ordonnance_mode TEXT DEFAULT 'a_la_livraison' CHECK(ordonnance_mode IN ('transmise','a_la_livraison')),
      ordonnance_presente INTEGER DEFAULT 0,
      consentement INTEGER DEFAULT 0,
      statut TEXT DEFAULT 'recue' CHECK(statut IN ('recue','validee','programmee','realisee','cr_signe','cloturee','refusee')),
      motif_refus TEXT,
      patient_id INTEGER REFERENCES patients(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS revenus (
      id SERIAL PRIMARY KEY,
      medecin_id INTEGER NOT NULL REFERENCES users(id),
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      montant DOUBLE PRECISION DEFAULT 150.0,
      date TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await seedData();
  return db;
}

// ─── Données initiales ──────────────────────────────────────────────────────

async function seedData() {
  const existingAdmin = await prepare('SELECT id FROM users WHERE email = ?').get('admin@somnohub.fr');
  if (existingAdmin) return;

  console.log('Initialisation des données de démonstration...');

  const insertUser = prepare(
    `INSERT INTO users (nom, prenom, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`
  );

  await insertUser.run('Admin', 'SomnoHub', 'admin@somnohub.fr', '$2a$10$RH.zoOLbdbxvU2pMrtJyZ.5O9SK94eEQzvdK8DglZP11mLGe4M0lS', 'admin');
  await insertUser.run('Martin', 'Sophie', 'dr.martin@somnohub.fr', '$2a$10$5xZcqK.JGP6MtOmnqdR21ur2fdxJuocf/xE6gZnnQri5oL.fjhEuO', 'medecin');
  await insertUser.run('Dupont', 'Pierre', 'dr.dupont@somnohub.fr', '$2a$10$i4RHbDJ1PriW7UfuIECvZuX2zP5FC/WGU/qWqVfBN3uSb17kWRuK2', 'medecin');
  await insertUser.run('Leblanc', 'Marc', 'livreur@somnohub.fr', '$2a$10$4WSmXiYAU1GKmIl.huvKGemi7HgRFV0EFhtWOraVTQq3PPmw/0Db2', 'livreur');
  await insertUser.run('Rousseau', 'Claire', 'assistante@somnohub.fr', '$2a$10$v3zmRu.8liumWWZANBndHuhc/7EJUPwI5cAFY6qulb0clh81CgUaO', 'assistante');

  const insertBoitier = prepare(`INSERT INTO boitiers (numero, statut, lat, lng) VALUES (?, 'disponible', ?, ?)`);
  for (let i = 1; i <= 10; i++) {
    await insertBoitier.run('SL-B' + String(i).padStart(2, '0'), 48.8566, 2.3522);
  }

  console.log('✅ Base initialisée — comptes créés, 10 boîtiers disponibles');
}

module.exports = { getDb, initDb, closeDb, withTransaction, getPool };
