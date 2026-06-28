const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const fs = require('fs');
const { getDb } = require('../db');
const auth = require('../middleware/auth');
const { genererAlertes } = require('../services/scheduler');
const { backupNow, dernieresSauvegardes } = require('../services/backup');
const { creerPatientAvecBoitier } = require('./medecin');

// ─── Boîtiers ───────────────────────────────────────────────────────────────

router.get('/boitiers', auth(['admin']), (req, res) => {
  const db = getDb();
  const boitiers = db.prepare(`
    SELECT b.*, p.nom as patient_nom, p.prenom as patient_prenom
    FROM boitiers b
    LEFT JOIN patients p ON b.patient_id = p.id
    ORDER BY b.numero
  `).all();
  res.json(boitiers);
});

router.post('/boitiers', auth(['admin']), (req, res) => {
  const { numero, tracker_gps } = req.body;
  if (!numero) return res.status(400).json({ error: 'Numéro de boîtier requis' });

  const db = getDb();
  try {
    const result = db.prepare(`INSERT INTO boitiers (numero, tracker_gps) VALUES (?, ?)`).run(numero.trim(), tracker_gps || null);
    res.status(201).json(db.prepare('SELECT * FROM boitiers WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: 'Numéro de boîtier déjà existant' });
  }
});

router.put('/boitiers/:id', auth(['admin']), (req, res) => {
  const { statut, tracker_gps, lat, lng } = req.body;
  const db = getDb();

  const boitier = db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
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

  db.prepare(`UPDATE boitiers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  genererAlertes();
  res.json(db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id));
});

// QR Code image d'un boîtier
router.get('/boitiers/:id/qrcode', auth(['admin']), async (req, res) => {
  const db = getDb();
  const boitier = db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });

  const png = await QRCode.toBuffer(boitier.numero, { width: 300, margin: 2 });
  res.set('Content-Type', 'image/png');
  res.send(png);
});

// Assigner manuellement un boîtier à un patient
router.post('/boitiers/:id/assigner', auth(['admin']), (req, res) => {
  const { patient_id } = req.body;
  const db = getDb();

  const boitier = db.prepare('SELECT * FROM boitiers WHERE id = ?').get(req.params.id);
  if (!boitier) return res.status(404).json({ error: 'Boîtier introuvable' });
  if (boitier.statut !== 'disponible') return res.status(400).json({ error: 'Boîtier non disponible' });

  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patient_id);
  if (!patient) return res.status(404).json({ error: 'Patient introuvable' });

  db.prepare(`UPDATE boitiers SET statut = 'assigne', patient_id = ?, derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(patient_id, boitier.id);
  db.prepare(`UPDATE patients SET statut = 'livraison_prevue', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(patient_id);

  const today = new Date().toISOString().split('T')[0];
  db.prepare(`INSERT INTO tournee_stops (date, type, patient_id, boitier_id, action, ordre) VALUES (?, 'soir', ?, ?, 'livrer', 99)`).run(today, patient_id, boitier.id);
  db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'livraison_prevue', ?, ?)`).run(patient_id, `Boîtier ${boitier.numero} assigné par l'admin`, req.user.id);

  res.json({ success: true });
});

// ─── Alertes ────────────────────────────────────────────────────────────────

router.get('/alertes', auth(['admin']), (req, res) => {
  const db = getDb();
  genererAlertes();
  const alertes = db.prepare(`
    SELECT a.*, b.numero as boitier_numero,
      p.nom as patient_nom, p.prenom as patient_prenom
    FROM alertes a
    LEFT JOIN boitiers b ON a.boitier_id = b.id
    LEFT JOIN patients p ON a.patient_id = p.id
    ORDER BY a.created_at DESC
    LIMIT 100
  `).all();
  const nonLues = db.prepare('SELECT COUNT(*) as nb FROM alertes WHERE lu = 0').get().nb;
  res.json({ alertes, non_lues: nonLues });
});

router.put('/alertes/:id/lu', auth(['admin']), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE alertes SET lu = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.put('/alertes/tout-lire', auth(['admin']), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE alertes SET lu = 1').run();
  res.json({ success: true });
});

// ─── Revenus ────────────────────────────────────────────────────────────────

router.get('/revenus', auth(['admin']), (req, res) => {
  const db = getDb();

  const moisActuel = new Date().toISOString().slice(0, 7);
  const moisPrecedent = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);

  const revenusMois = db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus WHERE date LIKE ?`).get(moisActuel + '%');
  const revenusMoisPrec = db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus WHERE date LIKE ?`).get(moisPrecedent + '%');

  // Par médecin ce mois
  const parMedecin = db.prepare(`
    SELECT u.nom, u.prenom, u.email,
      SUM(r.montant) as total_mois, COUNT(r.id) as nb_examens
    FROM revenus r
    JOIN users u ON r.medecin_id = u.id
    WHERE r.date LIKE ?
    GROUP BY r.medecin_id
    ORDER BY total_mois DESC
  `).all(moisActuel + '%');

  // Par jour — 30 derniers jours
  const parJour = db.prepare(`
    SELECT date, SUM(montant) as total, COUNT(*) as nb
    FROM revenus
    WHERE date >= date('now', '-30 days')
    GROUP BY date
    ORDER BY date ASC
  `).all();

  // Total général
  const totalGeneral = db.prepare(`SELECT SUM(montant) as total, COUNT(*) as nb FROM revenus`).get();

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

router.get('/medecins', auth(['admin']), (req, res) => {
  const db = getDb();
  const medecins = db.prepare(`
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

router.post('/medecins', auth(['admin']), (req, res) => {
  const { nom, prenom, email, password } = req.body;
  if (!nom || !prenom || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }

  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(`INSERT INTO users (nom, prenom, email, password_hash, role) VALUES (?, ?, ?, ?, 'medecin')`).run(nom.trim(), prenom.trim(), email.toLowerCase().trim(), hash);
    res.status(201).json({ id: result.lastInsertRowid, nom, prenom, email, actif: 1 });
  } catch (e) {
    res.status(400).json({ error: 'Email déjà utilisé' });
  }
});

router.put('/medecins/:id', auth(['admin']), (req, res) => {
  const { actif, password } = req.body;
  const db = getDb();

  if (actif !== undefined) {
    db.prepare('UPDATE users SET actif = ? WHERE id = ? AND role = ?').run(actif ? 1 : 0, req.params.id, 'medecin');
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND role = ?').run(hash, req.params.id, 'medecin');
  }

  res.json({ success: true });
});

// ─── Tableau de bord global ─────────────────────────────────────────────────

router.get('/dashboard', auth(['admin']), (req, res) => {
  const db = getDb();

  const statsBoitiers = db.prepare(`
    SELECT statut, COUNT(*) as nb FROM boitiers GROUP BY statut
  `).all();

  const statsPatients = db.prepare(`
    SELECT statut, COUNT(*) as nb FROM patients GROUP BY statut
  `).all();

  const nonLues = db.prepare('SELECT COUNT(*) as nb FROM alertes WHERE lu = 0').get().nb;

  res.json({ boitiers: statsBoitiers, patients: statsPatients, alertes_non_lues: nonLues });
});

// ─── Stats prescriptions ────────────────────────────────────────────────────

router.get('/prescriptions-stats', auth(['admin']), (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const debutSemaine = new Date(Date.now() - 6 * 86400000).toISOString().split('T')[0];
  const debutMois = today.slice(0, 7) + '-01';

  const parJour = db.prepare(`
    SELECT p.created_at, p.nom, p.prenom, p.statut, p.score_stop_bang,
      u.nom as medecin_nom, u.prenom as medecin_prenom
    FROM patients p JOIN users u ON p.medecin_id = u.id
    WHERE date(p.created_at) = ? ORDER BY p.created_at DESC
  `).all(today);

  const nbSemaine = db.prepare(`SELECT COUNT(*) as nb FROM patients WHERE date(created_at) >= ?`).get(debutSemaine).nb;
  const nbMois = db.prepare(`SELECT COUNT(*) as nb FROM patients WHERE date(created_at) >= ?`).get(debutMois).nb;

  const parMedecin = db.prepare(`
    SELECT u.nom, u.prenom,
      SUM(CASE WHEN date(p.created_at) = ? THEN 1 ELSE 0 END) as aujourd_hui,
      SUM(CASE WHEN date(p.created_at) >= ? THEN 1 ELSE 0 END) as semaine,
      SUM(CASE WHEN date(p.created_at) >= ? THEN 1 ELSE 0 END) as mois,
      COUNT(p.id) as total
    FROM users u LEFT JOIN patients p ON p.medecin_id = u.id
    WHERE u.role = 'medecin'
    GROUP BY u.id ORDER BY mois DESC
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

router.get('/patients', auth(['admin']), (req, res) => {
  const db = getDb();
  const patients = db.prepare(`
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

router.get('/sante', auth(['admin']), (req, res) => {
  const db = getDb();

  const nbPatients = db.prepare('SELECT COUNT(*) as n FROM patients').get().n;
  const nbBoitiers = db.prepare('SELECT COUNT(*) as n FROM boitiers').get().n;
  const parStatut = db.prepare('SELECT statut, COUNT(*) as nb FROM boitiers GROUP BY statut').all();
  const dernierScan = db.prepare(`SELECT MAX(completed_at) as d FROM tournee_stops WHERE statut = 'complete'`).get().d;
  const derniereActionBoitier = db.prepare('SELECT MAX(derniere_action) as d FROM boitiers').get().d;
  const nbSms = db.prepare('SELECT COUNT(*) as n FROM sms_log').get().n;
  const nbAlertesNonLues = db.prepare('SELECT COUNT(*) as n FROM alertes WHERE lu = 0').get().n;

  let db_taille = null, db_modifie = null;
  try {
    const st = fs.statSync(getDb().name);
    db_taille = st.size;
    db_modifie = st.mtime.toISOString();
  } catch (e) {}

  const sauvegardes = dernieresSauvegardes();

  res.json({
    patients: nbPatients,
    boitiers: { total: nbBoitiers, par_statut: parStatut },
    dernier_scan: dernierScan,
    derniere_action_boitier: derniereActionBoitier,
    sms_envoyes: nbSms,
    alertes_non_lues: nbAlertesNonLues,
    persistant: !!process.env.DB_PATH,
    db: { chemin: getDb().name, taille: db_taille, modifie: db_modifie },
    derniere_sauvegarde: sauvegardes[0] || null,
    nb_sauvegardes: sauvegardes.length
  });
});

router.post('/backup', auth(['admin']), async (req, res) => {
  try {
    const r = await backupNow();
    res.json({ success: true, ...r });
  } catch (e) {
    console.error('[Backup manuel] Erreur:', e);
    res.status(500).json({ error: 'Échec de la sauvegarde' });
  }
});

// ─── KPIs logistiques ────────────────────────────────────────────────────────

router.get('/kpis', auth(['admin']), (req, res) => {
  const db = getDb();
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

  // Délai moyen prescription → livraison (en jours)
  const prescLivr = db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT julianday(MIN(h.created_at)) - julianday(p.created_at) as d
      FROM patients p
      JOIN historique_patient h ON h.patient_id = p.id AND h.statut = 'livraison_effectuee'
      GROUP BY p.id
    )
  `).get().moy;

  // Délai moyen livraison → récupération
  const livrRecup = db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT julianday(MIN(r.created_at)) - julianday(MIN(l.created_at)) as d
      FROM patients p
      JOIN historique_patient l ON l.patient_id = p.id AND l.statut = 'livraison_effectuee'
      JOIN historique_patient r ON r.patient_id = p.id AND r.statut = 'en_cours_d_analyse'
      GROUP BY p.id
    )
  `).get().moy;

  // Délai moyen récupération → résultat
  const recupResultat = db.prepare(`
    SELECT AVG(d) as moy FROM (
      SELECT julianday(p.date_resultat) - julianday(MIN(r.created_at)) as d
      FROM patients p
      JOIN historique_patient r ON r.patient_id = p.id AND r.statut = 'en_cours_d_analyse'
      WHERE p.date_resultat IS NOT NULL
      GROUP BY p.id
    )
  `).get().moy;

  // Délai total prescription → résultat
  const total = db.prepare(`
    SELECT AVG(julianday(date_resultat) - julianday(created_at)) as moy
    FROM patients WHERE date_resultat IS NOT NULL
  `).get().moy;

  // Taux de boîtiers en retard (chez patient depuis +24h)
  const boitChez = db.prepare(`SELECT COUNT(*) as n FROM boitiers WHERE statut = 'chez_patient'`).get().n;
  const boitRetard = db.prepare(`SELECT COUNT(*) as n FROM boitiers WHERE statut = 'chez_patient' AND datetime(derniere_action) < datetime('now','-24 hours')`).get().n;

  // % examens menés au résultat (exploitables)
  const examensDemarres = db.prepare(`
    SELECT COUNT(DISTINCT patient_id) as n FROM historique_patient WHERE statut = 'examen_en_cours'
  `).get().n;
  const examensResultat = db.prepare(`SELECT COUNT(*) as n FROM patients WHERE date_resultat IS NOT NULL`).get().n;

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

router.get('/tournees-historique', auth(['admin']), (req, res) => {
  const db = getDb();

  // Données réelles dérivées des arrêts (nb, durée effective première→dernière complétion)
  const parJour = db.prepare(`
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
  const logs = db.prepare(`
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

router.get('/demandes', auth(['admin']), (req, res) => {
  const db = getDb();
  const { statut } = req.query;
  let demandes;
  if (statut) {
    demandes = db.prepare(`SELECT * FROM demandes WHERE statut = ? ORDER BY created_at DESC`).all(statut);
  } else {
    demandes = db.prepare(`SELECT * FROM demandes ORDER BY created_at DESC`).all();
  }
  const compteurs = {};
  for (const r of db.prepare(`SELECT statut, COUNT(*) as nb FROM demandes GROUP BY statut`).all()) {
    compteurs[r.statut] = r.nb;
  }
  res.json({ demandes, compteurs, recues: compteurs.recue || 0 });
});

router.get('/demandes/:id', auth(['admin']), (req, res) => {
  const db = getDb();
  const demande = db.prepare(`
    SELECT d.*, p.statut as patient_statut, b.numero as boitier_numero
    FROM demandes d
    LEFT JOIN patients p ON d.patient_id = p.id
    LEFT JOIN boitiers b ON b.patient_id = p.id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!demande) return res.status(404).json({ error: 'Demande introuvable' });
  res.json(demande);
});

router.put('/demandes/:id/valider', auth(['admin']), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'recue') return res.status(400).json({ error: 'Seule une demande reçue peut être validée' });
  db.prepare(`UPDATE demandes SET statut = 'validee', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.id);
  res.json({ success: true });
});

router.put('/demandes/:id/refuser', auth(['admin']), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'recue') return res.status(400).json({ error: 'Seule une demande reçue peut être refusée' });
  const { motif } = req.body;
  db.prepare(`UPDATE demandes SET statut = 'refusee', motif_refus = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(motif || null, d.id);
  res.json({ success: true });
});

router.put('/demandes/:id/programmer', auth(['admin']), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  if (d.statut !== 'validee') return res.status(400).json({ error: 'La demande doit être validée avant programmation' });

  // Réutilise le pipeline existant : crée le patient, assigne un boîtier, crée le stop, SMS.
  // Le prescripteur réel reste tracé en texte dans la demande ; medecin_id = admin.
  const note = d.medecin_nom ? `Demande programmée — prescripteur ${d.medecin_nom}` : 'Demande programmée';
  const patient = creerPatientAvecBoitier(db, {
    medecin_id: req.user.id,
    nom: d.patient_nom, prenom: d.patient_prenom,
    telephone: d.telephone, adresse: d.adresse, score_stop_bang: 0
  }, req.user.id, note);

  db.prepare(`UPDATE demandes SET statut = 'programmee', patient_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(patient.id, d.id);
  res.json({ success: true, patient });
});

router.put('/demandes/:id/ordonnance', auth(['admin']), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });
  const presente = req.body.presente ? 1 : 0;
  db.prepare(`UPDATE demandes SET ordonnance_presente = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(presente, d.id);
  res.json({ success: true, ordonnance_presente: presente });
});

router.put('/demandes/:id/statut', auth(['admin']), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM demandes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Demande introuvable' });

  const { statut } = req.body;
  const allowed = ['realisee', 'cr_signe', 'cloturee'];
  if (!allowed.includes(statut)) return res.status(400).json({ error: 'Statut non autorisé' });

  // Garde-fou : pas de signature de CR sans ordonnance au dossier
  if (statut === 'cr_signe' && !d.ordonnance_presente) {
    return res.status(400).json({ error: 'Ordonnance absente du dossier — signature du CR bloquée' });
  }

  db.prepare(`UPDATE demandes SET statut = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(statut, d.id);
  res.json({ success: true });
});

module.exports = router;
