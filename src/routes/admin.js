const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { getDb, withTransaction } = require('../db');
const auth = require('../middleware/auth');
const { genererAlertes } = require('../services/scheduler');
const { creerPatientAvecBoitier } = require('./medecin');
const { envoyerSMSTest, twilioConfigure } = require('../services/sms');

// ─── Boîtiers ───────────────────────────────────────────────────────────────

router.get('/boitiers', auth(['admin']), async (req, res) => {
  const db = getDb();
  const boitiers = await db.prepare(`
    SELECT b.*, p.nom as patient_nom, p.prenom as patient_prenom
    FROM boitiers b
    LEFT JOIN patients p ON b.patient_id = p.id
    ORDER BY b.numero
  `).all();
  res.json(boitiers);
});

router.post('/boitiers', auth(['admin']), async (req, res) => {
  const { numero, tracker_gps } = req.body;
  if (!numero) return res.status(400).json({ error: 'Numéro de boîtier requis' });

  const db = getDb();
  try {
    const result = await db.prepare(`INSERT INTO boitiers (numero, tracker_gps) VALUES (?, ?)`).run(numero.trim(), tracker_gps || null);
    res.status(201).json(await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'Numéro de boîtier déjà existant' });
  }
});

router.put('/boitiers/:id', auth(['admin']), async (req, res) => {
  const { statut, tracker_gps, lat, lng } = req.body;
  const db = getDb();

  const boitier = await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });

  const updates = [];
  const params = [];

  if (statut) { updates.push('statut = ?'); params.push(statut); }
  if (tracker_gps !== undefined) { updates.push('tracker_gps = ?'); params.push(tracker_gps); }
  if (lat !== undefined) { updates.push('lat = ?'); params.push(lat); }
  if (lng !== undefined) { updates.push('lng = ?'); params.push(lng); }

  if (updates.length === 0) return res.status(400).json({ error: 'Aucune modification' });

  updates.push('derniere_action = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  await db.prepare(`UPDATE boitiers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  await genererAlertes();
  res.json(await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id));
});

// QR Code image d'un boîtier
router.get('/boitiers/:id/qrcode', auth(['admin']), async (req, res) => {
  const db = getDb();
  const boitier = await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });

  const png = await QRCode.toBuffer(boitier.numero, { width: 300, margin: 2 });
  res.set('Content-Type', 'image/png');
  res.send(png);
});

// Assigner manuellement un boîtier à un patient
router.post('/boitiers/:id/assigner', auth(['admin']), async (req, res) => {
  const { patient_id } = req.body;
  const db = getDb();

  const boitier = await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });
  if (boitier.statut !== 'disponible') return res.status(400).json({ error: 'Boîtier non disponible' });

  const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(patient_id);
  if (!patient) return res.status(404).json({ error: 'Patient introuvable' });

  await db.prepare(`UPDATE boitiers SET statut = 'assigne', patient_id = ?, derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(patient_id, boitier.id);
  await db.prepare(`UPDATE patients SET statut = 'livraison_prevue', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(patient_id);

  const today = new Date().toISOString().split('T')[0];
  await db.prepare(`INSERT INTO tournee_stops (date, type, patient_id, boitier_id, action, ordre) VALUES (?, 'soir', ?, ?, 'livrer', 99)`).run(today, patient_id, boitier.id);
  await db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'livraison_prevue', ?, ?)`).run(patient_id, `Boîtier ${boitier.numero} assigné par l'admin`, req.user.id);

  res.json({ success: true });
});

// ─── Alertes ────────────────────────────────────────────────────────────────

router.get('/alertes', auth(['admin']), async (req, res) => {
  const db = getDb();
  await genererAlertes();
  const alertes = await db.prepare(`
    SELECT a.*, b.numero as boitier_numero,
      p.nom as patient_nom, p.prenom as patient_prenom
    FROM alertes a
    LEFT JOIN boitiers b ON a.boitier_id = b.id
    LEFT JOIN patients p ON a.patient_id = p.id
    ORDER BY a.created_at DESC
    LIMIT 100
  `).all();
  const nonLues = (await db.prepare('SELECT COUNT(*) as nb FROM alertes WHERE lu = 0').get()).nb;
  res.json({ alertes, non_lues: nonLues });
});

router.put('/alertes/:id/lu', auth(['admin']), async (req, res) => {
  const db = getDb();
  await db.prepare('UPDATE alertes SET lu = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.put('/alertes/tout-lire', auth(['admin']), async (req, res) => {
  const db = getDb();
  await db.prepare('UPDATE alertes SET lu = 1').run();
  res.json({ success: true });
});

// ─── Revenus ────────────────────────────────────────────────────────────────

router.get('/revenus', auth(['admin']), async (req, res) => {
  const db = getDb();

  const moisActuel = new Date().toISOString().slice(0, 7);
  const moisPrecedent = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);

  const revenusMois = await db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus WHERE date LIKE ?`).get(moisActuel + '%');
  const revenusMoisPrec = await db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus WHERE date LIKE ?`).get(moisPrecedent + '%');

  // Par médecin ce mois
  // PostgreSQL exige que toutes les colonnes non agrégées figurent dans GROUP BY
  const parMedecin = await db.prepare(`
    SELECT u.nom, u.prenom, u.email,
      SUM(r.montant) as total_mois, COUNT(r.id) as nb_examens
    FROM revenus r
    JOIN users u ON r.medecin_id = u.id
    WHERE r.date LIKE ?
    GROUP BY u.id, u.nom, u.prenom, u.email
    ORDER BY total_mois DESC
  `).all(moisActuel + '%');

  // Par jour — 30 derniers jours (colonne `date` stockée en TEXT 'YYYY-MM-DD')
  const parJour = await db.prepare(`
    SELECT date, SUM(montant) as total, COUNT(*) as nb
    FROM revenus
    WHERE date >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
    GROUP BY date
    ORDER BY date ASC
  `).all();

  // Total général
  const totalGeneral = await db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus`).get();

  // Projection fin de mois
  const joursEcoules = new Date().getDate();
  const joursTotal = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projection = joursEcoules > 0 ? ((revenusMois.total || 0) / joursEcoules) * joursTotal : 0;

  res.json({
    mois_actuel: { ...revenusMois, periode: moisActuel },
    mois_precedent: { ...revenusMoisPrec, periode: moisPrecedent },
    par_medecin: parMedecin,
    par_jour: parJour,
    total_general: totalGeneral,
    projection_fin_mois: Math.round(projection)
  });
});

// ─── Gestion des comptes médecins ───────────────────────────────────────────

router.get('/medecins', auth(['admin']), async (req, res) => {
  const db = getDb();
  const medecins = await db.prepare(`
    SELECT u.id, u.nom, u.prenom, u.email, u.actif, u.derniere_connexion, u.created_at,
      COUNT(p.id) as nb_prescriptions
    FROM users u
    LEFT JOIN patients p ON p.medecin_id = u.id
    WHERE u.role = 'medecin'
    GROUP BY u.id
    ORDER BY u.nom
  `).all();
  res.json(medecins);
});

router.post('/medecins', auth(['admin']), async (req, res) => {
  const { nom, prenom, email, password } = req.body;
  if (!nom || !prenom || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }

  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = await db.prepare(`INSERT INTO users (nom, prenom, email, password_hash, role) VALUES (?, ?, ?, ?, 'medecin')`).run(nom.trim(), prenom.trim(), email.toLowerCase().trim(), hash);
    res.status(201).json({ id: result.lastInsertRowid, nom, prenom, email, actif: 1 });
  } catch (e) {
    res.status(400).json({ error: 'Email déjà utilisé' });
  }
});

router.put('/medecins/:id', auth(['admin']), async (req, res) => {
  const { actif, password } = req.body;
  const db = getDb();

  if (actif !== undefined) {
    await db.prepare('UPDATE users SET actif = ? WHERE id = ? AND role = ?').run(actif ? 1 : 0, req.params.id, 'medecin');
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND role = ?').run(hash, req.params.id, 'medecin');
  }

  res.json({ success: true });
});

// ─── Tableau de bord global ─────────────────────────────────────────────────

router.get('/dashboard', auth(['admin']), async (req, res) => {
  const db = getDb();

  const statsBoitiers = await db.prepare(`
    SELECT statut, COUNT(*) as nb FROM boitiers GROUP BY statut
  `).all();

  const statsPatients = await db.prepare(`
    SELECT statut, COUNT(*) as nb FROM patients GROUP BY statut
  `).all();

  const nonLues = (await db.prepare('SELECT COUNT(*) as nb FROM alertes WHERE lu = 0').get()).nb;

  res.json({ boitiers: statsBoitiers, patients: statsPatients, alertes_non_lues: nonLues });
});

// ─── Stats prescriptions ────────────────────────────────────────────────────

router.get('/prescriptions-stats', auth(['admin']), async (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const debutSemaine = new Date(Date.now() - 6 * 86400000).toISOString().split('T')[0];
  const debutMois = today.slice(0, 7) + '-01';

  const parJour = await db.prepare(`
    SELECT p.created_at, p.nom, p.prenom, p.statut, p.score_stop_bang,
      u.nom as medecin_nom, u.prenom as medecin_prenom
    FROM patients p JOIN users u ON p.medecin_id = u.id
    WHERE p.created_at::date = ?::date ORDER BY p.created_at DESC
  `).all(today);

  const nbSemaine = (await db.prepare(`SELECT COUNT(*) as nb FROM patients WHERE created_at::date >= ?::date`).get(debutSemaine)).nb;
  const nbMois = (await db.prepare(`SELECT COUNT(*) as nb FROM patients WHERE created_at::date >= ?::date`).get(debutMois)).nb;

  const parMedecin = await db.prepare(`
    SELECT u.nom, u.prenom,
      SUM(CASE WHEN p.created_at::date = ?::date THEN 1 ELSE 0 END) as aujourd_hui,
      SUM(CASE WHEN p.created_at::date >= ?::date THEN 1 ELSE 0 END) as semaine,
      SUM(CASE WHEN p.created_at::date >= ?::date THEN 1 ELSE 0 END) as mois,
      COUNT(p.id) as total
    FROM users u LEFT JOIN patients p ON p.medecin_id = u.id
    WHERE u.role = 'medecin'
    GROUP BY u.id, u.nom, u.prenom ORDER BY mois DESC
  `).all(today, debutSemaine, debutMois);

  res.json({
    aujourd_hui: parJour.length,
    semaine: nbSemaine,
    mois: nbMois,
    prescriptions_du_jour: parJour,
    par_medecin: parMedecin
  });
});

// ─── Tous les patients (vue admin) ──────────────────────────────────────────

router.get('/patients', auth(['admin']), async (req, res) => {
  const db = getDb();
  const patients = await db.prepare(`
    SELECT p.*, u.nom as medecin_nom, u.prenom as medecin_prenom,
      b.numero as boitier_numero
    FROM patients p
    JOIN users u ON p.medecin_id = u.id
    LEFT JOIN boitiers b ON b.patient_id = p.id
    ORDER BY p.updated_at DESC
  `).all();
  res.json(patients);
});

// ─── Santé du système ───────────────────────────────────────────────────────

router.get('/sante', auth(['admin']), async (req, res) => {
  const db = getDb();

  const nbPatients = (await db.prepare('SELECT COUNT(*) as n FROM patients').get()).n;
  const nbBoitiers = (await db.prepare('SELECT COUNT(*) as n FROM boitiers').get()).n;
  const parStatut = await db.prepare('SELECT statut, COUNT(*) as nb FROM boitiers GROUP BY statut').all();
  const dernierScan = (await db.prepare(`SELECT MAX(completed_at) as d FROM tournee_stops WHERE statut = 'complete'`).get()).d;
  const derniereActionBoitier = (await db.prepare('SELECT MAX(derniere_action) as d FROM boitiers').get()).d;
  const nbSms = (await db.prepare('SELECT COUNT(*) as n FROM sms_log').get()).n;
  const nbAlertesNonLues = (await db.prepare('SELECT COUNT(*) as n FROM alertes WHERE lu = 0').get()).n;

  // Infos PostgreSQL (les sauvegardes sont gérées par l'hébergeur)
  let db_taille = null, db_version = null;
  try {
    db_taille = (await db.prepare('SELECT pg_database_size(current_database()) as t').get()).t;
    db_version = (await db.prepare('SHOW server_version').get()).server_version;
  } catch (e) {}

  res.json({
    patients: nbPatients,
    boitiers: { total: nbBoitiers, par_statut: parStatut },
    dernier_scan: dernierScan,
    derniere_action_boitier: derniereActionBoitier,
    sms_envoyes: nbSms,
    alertes_non_lues: nbAlertesNonLues,
    persistant: true,
    db: { moteur: 'PostgreSQL', version: db_version, taille: db_taille },
    sauvegardes_gerees_par: 'hébergeur (PostgreSQL managé)'
  });
});

// ─── KPIs logistiques ────────────────────────────────────────────────────────

router.get('/kpis', auth(['admin']), async (req, res) => {
  const db = getDb();
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

  // Délai moyen prescription → livraison (en jours)
  // NB : PostgreSQL exige un alias sur les sous-requêtes du FROM
  const prescLivr = (await db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT EXTRACT(EPOCH FROM (MIN(h.created_at) - p.created_at)) / 86400.0 as d
      FROM patients p
      JOIN historique_patient h ON h.patient_id = p.id AND h.statut = 'livraison_effectuee'
      GROUP BY p.id, p.created_at
    ) AS t
  `).get()).moy;

  // Délai moyen livraison → récupération
  const livrRecup = (await db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT EXTRACT(EPOCH FROM (MIN(r.created_at) - MIN(l.created_at))) / 86400.0 as d
      FROM patients p
      JOIN historique_patient l ON l.patient_id = p.id AND l.statut = 'livraison_effectuee'
      JOIN historique_patient r ON r.patient_id = p.id AND r.statut = 'en_cours_d_analyse'
      GROUP BY p.id
    ) AS t
  `).get()).moy;

  // Délai moyen récupération → résultat
  const recupResultat = (await db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT EXTRACT(EPOCH FROM (p.date_resultat - MIN(r.created_at))) / 86400.0 as d
      FROM patients p
      JOIN historique_patient r ON r.patient_id = p.id AND r.statut = 'en_cours_d_analyse'
      WHERE p.date_resultat IS NOT NULL
      GROUP BY p.id, p.date_resultat
    ) AS t
  `).get()).moy;

  // Délai total prescription → résultat
  const total = (await db.prepare(`
    SELECT AVG(EXTRACT(EPOCH FROM (date_resultat - created_at)) / 86400.0) as moy
    FROM patients WHERE date_resultat IS NOT NULL
  `).get()).moy;

  // Taux de boîtiers en retard (chez patient depuis +24h)
  const boitChez = (await db.prepare(`SELECT COUNT(*) as n FROM boitiers WHERE statut = 'chez_patient'`).get()).n;
  const boitRetard = (await db.prepare(`SELECT COUNT(*) as n FROM boitiers WHERE statut = 'chez_patient' AND derniere_action < NOW() - INTERVAL '24 hours'`).get()).n;

  // % examens menés au résultat (exploitables)
  const examensDemarres = (await db.prepare(`
    SELECT COUNT(DISTINCT patient_id) as n FROM historique_patient WHERE statut = 'examen_en_cours'
  `).get()).n;
  const examensResultat = (await db.prepare(`SELECT COUNT(*) as n FROM patients WHERE date_resultat IS NOT NULL`).get()).n;

  res.json({
    delai_prescription_livraison_j: r1(prescLivr),
    delai_livraison_recup_j: r1(livrRecup),
    delai_recup_resultat_j: r1(recupResultat),
    delai_total_j: r1(total),
    boitiers_en_retard: {
      total: boitChez,
      en_retard: boitRetard,
      taux: boitChez > 0 ? Math.round((boitRetard / boitChez) * 100) : 0
    },
    examens: {
      demarres: examensDemarres,
      avec_resultat: examensResultat,
      taux_exploitables: examensDemarres > 0 ? Math.round((examensResultat / examensDemarres) * 100) : null
    }
  });
});

// ─── Historique des tournées ─────────────────────────────────────────────────

router.get('/tournees-historique', auth(['admin']), async (req, res) => {
  const db = getDb();

  // Données réelles dérivées des arrêts (nb, durée effective première→dernière complétion)
  const parJour = await db.prepare(`
    SELECT date,
      SUM(CASE WHEN action = 'livrer' THEN 1 ELSE 0 END) as livraisons,
      SUM(CASE WHEN action = 'recuperer' THEN 1 ELSE 0 END) as recups,
      SUM(CASE WHEN statut = 'complete' THEN 1 ELSE 0 END) as completes,
      COUNT(*) as total,
      MIN(CASE WHEN statut = 'complete' THEN completed_at END) as debut,
      MAX(CASE WHEN statut = 'complete' THEN completed_at END) as fin
    FROM tournee_stops
    GROUP BY date
    ORDER BY date DESC
    LIMIT 30
  `).all();

  // Métriques d'optimisation (km, durée estimée) loggées par l'app livreur
  const logs = await db.prepare(`
    SELECT date, MAX(distance_km) as distance_km, MAX(duree_min) as duree_min, MAX(nb_arrets) as nb_arrets
    FROM tournees_log GROUP BY date
  `).all();
  const logMap = {};
  for (const l of logs) logMap[l.date] = l;

  const historique = parJour.map(j => {
    let dureeReelleMin = null;
    if (j.debut && j.fin) {
      // différence en minutes entre la première et la dernière complétion
      const diffJours = (Date.parse(j.fin) - Date.parse(j.debut)) / 86400000;
      dureeReelleMin = Math.max(0, Math.round(diffJours * 24 * 60));
    }
    const log = logMap[j.date] || {};
    return {
      date: j.date,
      livraisons: j.livraisons,
      recups: j.recups,
      completes: j.completes,
      total: j.total,
      duree_reelle_min: dureeReelleMin,
      distance_km: log.distance_km != null ? log.distance_km : null,
      duree_estimee_min: log.duree_min != null ? log.duree_min : null
    };
  });

  res.json(historique);
});

// ─── Demandes de polygraphie (cockpit) ──────────────────────────────────────

router.get('/demandes', auth(['admin']), async (req, res) => {
  const db = getDb();
  const { statut } = req.query;
  let demandes;
  if (statut) {
    demandes = await db.prepare(`SELECT * FROM demandes WHERE statut = ? ORDER BY created_at DESC`).all(statut);
  } else {
    demandes = await db.prepare(`SELECT * FROM demandes ORDER BY created_at DESC`).all();
  }
  const compteurs = {};
  for (const r of await db.prepare(`SELECT statut, COUNT(*) as nb FROM demandes GROUP BY statut`).all()) {
    compteurs[r.statut] = r.nb;
  }
  res.json({ demandes, compteurs, recues: compteurs.recue || 0 });
});

router.get('/demandes/:id', auth(['admin']), async (req, res) => {
  const db = getDb();
  const demande = await db.prepare(`
    SELECT d.*, p.statut as patient_statut, b.numero as boitier_numero
    FROM demandes d
    LEFT JOIN patients p ON d.patient_id = p.id
    LEFT JOIN boitiers b ON b.patient_id = p.id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!demande) return res.status(404).json({ error: 'Demande introuvable' });
  res.json(demande);
});

router.put('/demandes/:id/valider', auth(['admin']), async (req, res) => {
  const db = getDb();
  const d = await db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'recue') return res.status(400).json({ error: 'Seule une demande reçue peut être validée' });
  await db.prepare(`UPDATE demandes SET statut = 'validee', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.id);
  res.json({ success: true });
});

router.put('/demandes/:id/refuser', auth(['admin']), async (req, res) => {
  const db = getDb();
  const d = await db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'recue') return res.status(400).json({ error: 'Seule une demande reçue peut être refusée' });
  const { motif } = req.body;
  await db.prepare(`UPDATE demandes SET statut = 'refusee', motif_refus = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(motif || null, d.id);
  res.json({ success: true });
});

router.put('/demandes/:id/programmer', auth(['admin']), async (req, res) => {
  const db = getDb();
  const d = await db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'validee') return res.status(400).json({ error: 'La demande doit être validée avant programmation' });

  // Réutilise le pipeline existant : crée le patient, assigne un boîtier, crée le stop, SMS.
  // Le prescripteur réel reste tracé en texte dans la demande ; medecin_id = admin.
  const note = d.medecin_nom ? `Demande programmée — prescripteur ${d.medecin_nom}` : 'Demande programmée';
  const patient = await creerPatientAvecBoitier(db, {
    medecin_id: req.user.id,
    nom: d.patient_nom, prenom: d.patient_prenom,
    telephone: d.telephone, adresse: d.adresse,
    lat: d.lat, lng: d.lng, score_stop_bang: 0
  }, req.user.id, note);

  await db.prepare(`UPDATE demandes SET statut = 'programmee', patient_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(patient.id, d.id);
  res.json({ success: true, patient });
});

router.put('/demandes/:id/ordonnance', auth(['admin']), async (req, res) => {
  const db = getDb();
  const d = await db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  const presente = req.body.presente ? 1 : 0;
  await db.prepare(`UPDATE demandes SET ordonnance_presente = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(presente, d.id);
  res.json({ success: true, ordonnance_presente: presente });
});

router.put('/demandes/:id/statut', auth(['admin']), async (req, res) => {
  const db = getDb();
  const d = await db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });

  const { statut } = req.body;
  const allowed = ['realisee', 'cr_signe', 'cloturee'];
  if (!allowed.includes(statut)) return res.status(400).json({ error: 'Statut non autorisé' });

  // Garde-fou : pas de signature de CR sans ordonnance au dossier
  if (statut === 'cr_signe' && !d.ordonnance_presente) {
    return res.status(400).json({ error: 'Ordonnance absente du dossier — signature du CR bloquée' });
  }

  await db.prepare(`UPDATE demandes SET statut = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(statut, d.id);
  res.json({ success: true });
});

// ─── Suppression patient / désassignation boîtier ───────────────────────────

// Désassigner un boîtier de son patient (le boîtier redevient disponible)
router.post('/boitiers/:id/desassigner', auth(['admin']), async (req, res) => {
  const db = getDb();
  const boitier = await db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });
  if (!boitier.patient_id) return res.status(400).json({ error: 'Ce boîtier n\'est pas assigné' });

  const patientId = boitier.patient_id;
  await withTransaction(async (tx) => {
    await tx.prepare(`UPDATE boitiers SET statut = 'disponible', patient_id = NULL, derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.id);
    await tx.prepare(`DELETE FROM tournee_stops WHERE boitier_id = ? AND statut = 'en_attente'`).run(boitier.id);
    const p = await tx.prepare('SELECT id FROM patients WHERE id = ?').get(patientId);
    if (p) {
      await tx.prepare(`UPDATE patients SET statut = 'prescrit', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(patientId);
      await tx.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'prescrit', ?, ?)`).run(patientId, `Boîtier ${boitier.numero} désassigné par l'admin`, req.user.id);
    }
  });
  res.json({ success: true });
});

// Supprimer définitivement un patient (avec nettoyage des données liées)
router.delete('/patients/:id', auth(['admin']), async (req, res) => {
  const db = getDb();
  const patient = await db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Patient introuvable' });

  await withTransaction(async (tx) => {
    // Libérer les boîtiers assignés à ce patient
    await tx.prepare(`UPDATE boitiers SET statut = 'disponible', patient_id = NULL, derniere_action = CURRENT_TIMESTAMP WHERE patient_id = ?`).run(patient.id);
    // Supprimer les enregistrements dépendants (FK)
    await tx.prepare('DELETE FROM tournee_stops WHERE patient_id = ?').run(patient.id);
    await tx.prepare('DELETE FROM historique_patient WHERE patient_id = ?').run(patient.id);
    await tx.prepare('DELETE FROM sms_log WHERE patient_id = ?').run(patient.id);
    await tx.prepare('DELETE FROM revenus WHERE patient_id = ?').run(patient.id);
    await tx.prepare('DELETE FROM alertes WHERE patient_id = ?').run(patient.id);
    // Délier les demandes (on conserve la demande, sans lien patient)
    await tx.prepare('UPDATE demandes SET patient_id = NULL WHERE patient_id = ?').run(patient.id);
    await tx.prepare('DELETE FROM patients WHERE id = ?').run(patient.id);
  });
  res.json({ success: true });
});

// ─── SMS Twilio (statut + test) ──────────────────────────────────────────────

router.get('/sms-status', auth(['admin']), (req, res) => {
  res.json({ configure: twilioConfigure() });
});

router.post('/test-sms', auth(['admin']), async (req, res) => {
  const { telephone } = req.body;
  if (!telephone) return res.status(400).json({ error: 'Numéro de téléphone requis' });
  try {
    const sid = await envoyerSMSTest(telephone, 'Test SomnoHub : votre configuration SMS fonctionne. ✅');
    res.json({ success: true, sid });
  } catch (e) {
    console.error('[Test SMS] Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
