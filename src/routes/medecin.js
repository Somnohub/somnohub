const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const auth = require('../middleware/auth');
const { smsPrescription } = require('../services/sms');
const { genererAlertes } = require('../services/scheduler');

// Liste des patients du médecin
router.get('/patients', auth(['medecin']), (req, res) => {
  const db = getDb();
  const patients = db.prepare(`
    SELECT p.*, b.numero as boitier_numero
    FROM patients p
    LEFT JOIN boitiers b ON b.patient_id = p.id AND b.statut != 'disponible'
    WHERE p.medecin_id = ?
    ORDER BY p.updated_at DESC
  `).all(req.user.id);
  res.json(patients);
});

// Dossier complet d'un patient
router.get('/patients/:id', auth(['medecin']), (req, res) => {
  const db = getDb();
  const patient = db.prepare(`
    SELECT p.*, b.numero as boitier_numero, b.statut as boitier_statut
    FROM patients p
    LEFT JOIN boitiers b ON b.patient_id = p.id
    WHERE p.id = ? AND p.medecin_id = ?
  `).get(req.params.id, req.user.id);

  if (!patient) return res.status(404).json({ error: 'Patient introuvable' });

  const historique = db.prepare(`
    SELECT h.*, u.nom as auteur_nom, u.prenom as auteur_prenom, u.role as auteur_role
    FROM historique_patient h
    LEFT JOIN users u ON h.created_by = u.id
    WHERE h.patient_id = ?
    ORDER BY h.created_at DESC
  `).all(patient.id);

  const smsLogs = db.prepare(`
    SELECT * FROM sms_log WHERE patient_id = ? ORDER BY created_at DESC
  `).all(patient.id);

  res.json({ ...patient, historique, smsLogs });
});

// Créer une prescription
router.post('/patients', auth(['medecin']), async (req, res) => {
  const { nom, prenom, telephone, adresse, lat, lng, score_stop_bang } = req.body;

  if (!nom || !prenom || !telephone || !adresse) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  const db = getDb();

  // Chercher un boîtier disponible
  const boitierDispo = db.prepare(`SELECT * FROM boitiers WHERE statut = 'disponible' LIMIT 1`).get();

  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const result = db.prepare(`
    INSERT INTO patients (medecin_id, nom, prenom, telephone, adresse, lat, lng, score_stop_bang, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    nom.trim(), prenom.trim(), telephone.trim(), adresse.trim(),
    lat || 48.8566, lng || 2.3522,
    score_stop_bang || 0,
    boitierDispo ? 'livraison_prevue' : 'prescrit'
  );

  const patientId = result.lastInsertRowid;

  if (boitierDispo) {
    // Assigner le boîtier
    db.prepare(`
      UPDATE boitiers SET patient_id = ?, statut = 'assigne', derniere_action = CURRENT_TIMESTAMP WHERE id = ?
    `).run(patientId, boitierDispo.id);

    // Créer le stop tournée soir
    db.prepare(`
      INSERT INTO tournee_stops (date, type, patient_id, boitier_id, action, ordre) VALUES (?, 'soir', ?, ?, 'livrer', ?)
    `).run(today, patientId, boitierDispo.id, 99);

    db.prepare(`
      INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'livraison_prevue', ?, ?)
    `).run(patientId, `Boîtier ${boitierDispo.numero} assigné automatiquement`, req.user.id);
  }

  db.prepare(`
    INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'prescrit', 'Prescription créée', ?)
  `).run(patientId, req.user.id);

  // Envoyer SMS si boîtier assigné
  if (boitierDispo) {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    smsPrescription(patient).catch(console.error);
  }

  genererAlertes();

  const patient = db.prepare(`
    SELECT p.*, b.numero as boitier_numero FROM patients p
    LEFT JOIN boitiers b ON b.patient_id = p.id
    WHERE p.id = ?
  `).get(patientId);

  res.status(201).json(patient);
});

// Mettre à jour le statut d'un patient (ex: consultation_annonce)
router.put('/patients/:id/statut', auth(['medecin']), (req, res) => {
  const { statut, note } = req.body;
  const db = getDb();

  const patient = db.prepare('SELECT * FROM patients WHERE id = ? AND medecin_id = ?').get(req.params.id, req.user.id);
  if (!patient) return res.status(404).json({ error: 'Patient introuvable' });

  db.prepare('UPDATE patients SET statut = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(statut, patient.id);
  db.prepare('INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, ?, ?, ?)').run(patient.id, statut, note || null, req.user.id);

  res.json({ success: true });
});

// Onglet Suivi — patients en suivi long terme
router.get('/suivi', auth(['medecin']), (req, res) => {
  const db = getDb();
  const now = new Date();
  const dans15Jours = new Date(now.getTime() + 15 * 86400000).toISOString();

  const patients = db.prepare(`
    SELECT * FROM patients
    WHERE medecin_id = ? AND date_resultat IS NOT NULL
    AND statut = 'consultation_annonce'
    ORDER BY date_resultat ASC
  `).all(req.user.id);

  const enrichis = patients.map(p => {
    const dr = new Date(p.date_resultat);
    const suivi3 = new Date(dr.getTime() + 90 * 86400000);
    const suivi6 = new Date(dr.getTime() + 180 * 86400000);
    const suivi1an = new Date(dr.getTime() + 365 * 86400000);

    return {
      ...p,
      suivi_3mois_date: suivi3.toISOString().split('T')[0],
      suivi_6mois_date: suivi6.toISOString().split('T')[0],
      suivi_1an_date: suivi1an.toISOString().split('T')[0],
      en_retard_3mois: suivi3 < now && !p.suivi_3mois_envoye,
      en_retard_6mois: suivi6 < now && !p.suivi_6mois_envoye,
      en_retard_1an: suivi1an < now && !p.suivi_1an_envoye,
      echeance_3mois: suivi3 <= new Date(dans15Jours) && !p.suivi_3mois_envoye,
      echeance_6mois: suivi6 <= new Date(dans15Jours) && !p.suivi_6mois_envoye,
      echeance_1an: suivi1an <= new Date(dans15Jours) && !p.suivi_1an_envoye,
    };
  });

  res.json(enrichis);
});

module.exports = router;
