const cron = require('node-cron');
const { getDb } = require('../db');
const { smsSuivi3Mois, smsSuivi6Mois, smsSuivi1An, smsRappelRecuperation } = require('./sms');

function startScheduler() {
  // Vérification SMS de suivi — chaque jour à 8h00
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Vérification SMS de suivi...');
    const db = getDb();

    const maintenant = new Date();
    const dans15Jours = new Date(maintenant.getTime() + 15 * 86400000);

    const patients = db.prepare(`
      SELECT p.*, u.nom as medecin_nom, u.prenom as medecin_prenom
      FROM patients p
      JOIN users u ON p.medecin_id = u.id
      WHERE p.date_resultat IS NOT NULL AND p.statut = 'consultation_annonce'
    `).all();

    for (const patient of patients) {
      const dateResultat = new Date(patient.date_resultat);
      const medecin = { nom: patient.medecin_nom, prenom: patient.medecin_prenom };

      // 3 mois = 90 jours
      const date3Mois = new Date(dateResultat.getTime() + 90 * 86400000);
      if (!patient.suivi_3mois_envoye && date3Mois <= dans15Jours) {
        await smsSuivi3Mois(patient, medecin);
        db.prepare('UPDATE patients SET suivi_3mois_envoye = 1 WHERE id = ?').run(patient.id);
      }

      // 6 mois = 180 jours
      const date6Mois = new Date(dateResultat.getTime() + 180 * 86400000);
      if (!patient.suivi_6mois_envoye && date6Mois <= dans15Jours) {
        await smsSuivi6Mois(patient, medecin);
        db.prepare('UPDATE patients SET suivi_6mois_envoye = 1 WHERE id = ?').run(patient.id);
      }

      // 1 an = 365 jours
      const date1An = new Date(dateResultat.getTime() + 365 * 86400000);
      if (!patient.suivi_1an_envoye && date1An <= dans15Jours) {
        await smsSuivi1An(patient, medecin);
        db.prepare('UPDATE patients SET suivi_1an_envoye = 1 WHERE id = ?').run(patient.id);
      }
    }
  });

  // Rappel récupération — chaque jour à 7h00
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Envoi rappels récupération...');
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];

    const stops = db.prepare(`
      SELECT ts.*, p.prenom, p.telephone, p.id as patient_id
      FROM tournee_stops ts
      JOIN patients p ON ts.patient_id = p.id
      WHERE ts.date = ? AND ts.type = 'matin' AND ts.action = 'recuperer' AND ts.statut = 'en_attente'
    `).all(today);

    for (const stop of stops) {
      await smsRappelRecuperation({ id: stop.patient_id, prenom: stop.prenom, telephone: stop.telephone });
    }
  });

  // Vérification alertes — toutes les 6 heures
  cron.schedule('0 */6 * * *', () => {
    genererAlertes();
  });

  console.log('[Scheduler] Tâches planifiées démarrées');
}

function genererAlertes() {
  const db = getDb();

  // Boîtier chez patient depuis +48h
  const boitiersImmobiles = db.prepare(`
    SELECT b.*, p.nom, p.prenom FROM boitiers b
    LEFT JOIN patients p ON b.patient_id = p.id
    WHERE b.statut = 'chez_patient'
    AND datetime(b.derniere_action) < datetime('now', '-48 hours')
  `).all();

  for (const b of boitiersImmobiles) {
    const existante = db.prepare(`
      SELECT id FROM alertes WHERE boitier_id = ? AND type = 'boitier_immobile' AND lu = 0
    `).get(b.id);
    if (!existante) {
      db.prepare(`INSERT INTO alertes (type, message, boitier_id, patient_id) VALUES (?, ?, ?, ?)`).run(
        'boitier_immobile',
        `Boîtier ${b.numero} chez le patient ${b.prenom} ${b.nom} depuis +48h`,
        b.id, b.patient_id
      );
    }
  }

  // Maintenance +24h
  const boitiersMaint = db.prepare(`
    SELECT * FROM boitiers WHERE statut = 'maintenance'
    AND datetime(derniere_action) < datetime('now', '-24 hours')
  `).all();

  for (const b of boitiersMaint) {
    const existante = db.prepare(`
      SELECT id FROM alertes WHERE boitier_id = ? AND type = 'maintenance_longue' AND lu = 0
    `).get(b.id);
    if (!existante) {
      db.prepare(`INSERT INTO alertes (type, message, boitier_id) VALUES (?, ?, ?)`).run(
        'maintenance_longue',
        `Boîtier ${b.numero} en maintenance depuis +24h`,
        b.id
      );
    }
  }

  // Stock critique — moins de 3 disponibles
  const nbDispo = db.prepare(`SELECT COUNT(*) as nb FROM boitiers WHERE statut = 'disponible'`).get().nb;
  if (nbDispo < 3) {
    const existante = db.prepare(`SELECT id FROM alertes WHERE type = 'stock_critique' AND lu = 0`).get();
    if (!existante) {
      db.prepare(`INSERT INTO alertes (type, message) VALUES (?, ?)`).run(
        'stock_critique',
        `Stock critique : seulement ${nbDispo} boîtier(s) disponible(s) au local`
      );
    }
  }
}

module.exports = { startScheduler, genererAlertes };
