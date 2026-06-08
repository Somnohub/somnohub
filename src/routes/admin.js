const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { getDb } = require('../db');
const auth = require('../middleware/auth');
const { genererAlertes } = require('../services/scheduler');

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

module.exports = router;
