const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const auth = require('../middleware/auth');

// Jours ayant des stops sur les 21 prochains jours + 7 passés
router.get('/jours-tournees', auth(['livreur', 'admin']), (req, res) => {
  const db = getDb();
  const jours = db.prepare(`
    SELECT date, type,
      COUNT(*) as nb_stops,
      SUM(CASE WHEN statut = 'complete' THEN 1 ELSE 0 END) as nb_complete,
      SUM(CASE WHEN statut = 'en_attente' THEN 1 ELSE 0 END) as nb_attente
    FROM tournee_stops
    WHERE date >= date('now', '-7 days')
      AND date <= date('now', '+21 days')
    GROUP BY date, type
    ORDER BY date ASC, type ASC
  `).all();

  // Regrouper par date
  const parDate = {};
  for (const j of jours) {
    if (!parDate[j.date]) parDate[j.date] = { date: j.date, matin: null, soir: null, total: 0, total_attente: 0 };
    parDate[j.date][j.type] = j;
    parDate[j.date].total += j.nb_stops;
    parDate[j.date].total_attente += j.nb_attente;
  }

  res.json(Object.values(parDate));
});

// Prescriptions en attente d'assignation (pour seuil tournée)
router.get('/prescriptions-en-attente', auth(['livreur', 'admin']), (req, res) => {
  const db = getDb();
  const count = db.prepare(`SELECT COUNT(*) as nb FROM patients WHERE statut = 'prescrit'`).get();
  const seuil = 20;
  res.json({ nb: count.nb, seuil, seuil_atteint: count.nb >= seuil });
});

// Tournées du jour
router.get('/tournees', auth(['livreur', 'admin']), (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const type = req.query.type;

  let query = `
    SELECT ts.*,
      p.nom as patient_nom, p.prenom as patient_prenom,
      p.telephone as patient_telephone, p.adresse as patient_adresse,
      p.lat as patient_lat, p.lng as patient_lng,
      b.numero as boitier_numero
    FROM tournee_stops ts
    JOIN patients p ON ts.patient_id = p.id
    LEFT JOIN boitiers b ON ts.boitier_id = b.id
    WHERE ts.date = ?
  `;
  const params = [date];

  if (type) {
    query += ' AND ts.type = ?';
    params.push(type);
  }

  query += ' ORDER BY ts.type, ts.ordre, ts.id';

  const stops = db.prepare(query).all(...params);
  res.json(stops);
});

// Scanner un QR code (action livreur)
router.post('/scan', auth(['livreur']), (req, res) => {
  const { boitier_numero, stop_id } = req.body;

  if (!boitier_numero) {
    return res.status(400).json({ error: 'Numéro de boîtier requis' });
  }

  const db = getDb();
  const boitier = db.prepare('SELECT * FROM boitiers WHERE numero = ?').get(boitier_numero);

  if (!boitier) {
    return res.status(404).json({ error: `Boîtier ${boitier_numero} introuvable` });
  }

  let stop = null;
  if (stop_id) {
    stop = db.prepare('SELECT * FROM tournee_stops WHERE id = ?').get(stop_id);
  }

  const action = stop ? stop.action : null;
  let message = '';
  let nouveauStatutBoitier = boitier.statut;
  let nouveauStatutPatient = null;

  // Logique selon le statut actuel du boîtier
  if (boitier.statut === 'assigne' || action === 'livrer') {
    // Livraison chez le patient
    nouveauStatutBoitier = 'chez_patient';
    nouveauStatutPatient = 'examen_en_cours';
    message = `✅ Boîtier ${boitier_numero} livré chez le patient`;

    db.prepare(`UPDATE boitiers SET statut = 'chez_patient', derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.id);

    if (boitier.patient_id) {
      db.prepare(`UPDATE patients SET statut = 'examen_en_cours', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.patient_id);
      db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'livraison_effectuee', 'Boîtier déposé chez le patient', ?)`).run(boitier.patient_id, req.user.id);
      db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'examen_en_cours', 'Examen démarré', ?)`).run(boitier.patient_id, req.user.id);

      // Créer un stop de récupération pour le lendemain matin
      const demain = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      const existeStop = db.prepare(`SELECT id FROM tournee_stops WHERE date = ? AND type = 'matin' AND boitier_id = ?`).get(demain, boitier.id);
      if (!existeStop) {
        db.prepare(`INSERT INTO tournee_stops (date, type, patient_id, boitier_id, action, ordre) VALUES (?, 'matin', ?, ?, 'recuperer', 99)`).run(demain, boitier.patient_id, boitier.id);
      }
    }

  } else if (boitier.statut === 'chez_patient' || action === 'recuperer') {
    // Récupération chez le patient — en attente de nettoyage par l'assistante
    nouveauStatutBoitier = 'en_analyse';
    nouveauStatutPatient = 'en_cours_d_analyse';
    message = `✅ Boîtier ${boitier_numero} récupéré — En cours d'analyse`;

    db.prepare(`UPDATE boitiers SET statut = 'en_analyse', derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.id);

    if (boitier.patient_id) {
      db.prepare(`UPDATE patients SET statut = 'en_cours_d_analyse', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.patient_id);
      db.prepare(`INSERT INTO historique_patient (patient_id, statut, note, created_by) VALUES (?, 'en_cours_d_analyse', 'Boîtier récupéré — données en cours d\\'analyse', ?)`).run(boitier.patient_id, req.user.id);
    }

  } else if (boitier.statut === 'disponible') {
    // Scan au départ du local
    nouveauStatutBoitier = 'assigne';
    message = `✅ Boîtier ${boitier_numero} scanné au départ — Assigné`;
    db.prepare(`UPDATE boitiers SET statut = 'assigne', derniere_action = CURRENT_TIMESTAMP WHERE id = ?`).run(boitier.id);

  } else {
    return res.status(400).json({
      error: `Boîtier ${boitier_numero} en statut "${boitier.statut}" — action non autorisée`,
      statut_actuel: boitier.statut
    });
  }

  // Marquer le stop comme complété
  if (stop) {
    db.prepare(`UPDATE tournee_stops SET statut = 'complete', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(stop.id);
  }

  res.json({
    success: true,
    message,
    boitier_numero,
    nouveau_statut_boitier: nouveauStatutBoitier,
    nouveau_statut_patient: nouveauStatutPatient
  });
});

// Signaler un problème sur un stop
router.put('/stops/:id/echec', auth(['livreur']), (req, res) => {
  const db = getDb();
  db.prepare(`UPDATE tournee_stops SET statut = 'echec' WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
