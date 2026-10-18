/**
 * Serveur backend de Tamisé — à déployer sur Render.
 *
 * Quatre rôles :
 *  1. Garder la clé API Infomaniak en sécurité et relayer les demandes d'IA.
 *  2. Stocker les données partagées d'une relation (messages, agenda, dépenses…)
 *     pour que deux téléphones voient la même chose.
 *  3. Extraire le texte des documents ajoutés (PDF) et retrouver, dans ce
 *     texte, les passages qui répondent à une question posée à Iris.
 *  4. Servir de boîte aux lettres aux photos de la conversation : elles y
 *     arrivent chiffrées (illisibles pour le serveur) et sont effacées dès
 *     que l'autre téléphone les a récupérées.
 *
 * Base de données : MySQL (service managé Infomaniak, hébergé en Suisse).
 *
 * Variables d'environnement attendues sur Render :
 *   INFOMANIAK_PRODUCT_ID   ton identifiant produit AI Services
 *   INFOMANIAK_API_KEY      ton token API Infomaniak
 *   INFOMANIAK_MODEL        le nom EXACT du modèle, copié depuis la page
 *                           /api/modeles de ce serveur
 *                           (ex. Qwen/Qwen3.5-122B-A10B-FP8)
 *   DATABASE_URL            adresse de la base MySQL, sous la forme
 *                           mysql://utilisateur:motdepasse@serveur:port/nom_base
 *
 * Dépendances à installer une fois dans ce dossier :
 *   npm install pdf-parse
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const pdfParse = require("pdf-parse");
const { TEXTES_LOI } = require("./textes-loi");

const app = express();
// 25 Mo : un jugement de plusieurs centaines de pages, encodé en base64, pèse
// bien plus que les 10 Mo qui suffisaient aux photos.
app.use(express.json({ limit: "25mb" }));

// Seules ces adresses peuvent utiliser ce serveur. Sans ça, n'importe quel
// site pourrait consommer le crédit Infomaniak.
app.use(cors({ origin: ["https://tamise.netlify.app"] }));

// Exception : l'agenda auquel on s'abonne est lu par Google, Apple ou Outlook,
// pas par le site. Il doit donc rester accessible à eux aussi. L'adresse
// contient un identifiant tiré au hasard : c'est elle qui protège l'accès.
app.get("/api/agenda/:relationId.ics", cors({ origin: "*" }), (req, res, next) => next());

const INFOMANIAK_PRODUCT_ID = process.env.INFOMANIAK_PRODUCT_ID;
const INFOMANIAK_API_KEY = process.env.INFOMANIAK_API_KEY;
// Modèle utilisé. Défini ici (côté serveur) plutôt que dans l'application :
// ça permet d'en changer sans avoir à reconstruire tout le site.
// Nettoyé des espaces et guillemets qu'un copier-coller ajoute facilement.
const INFOMANIAK_MODEL = (process.env.INFOMANIAK_MODEL || "").trim().replace(/^["'`«\s]+|["'`»\s]+$/g, "");
// Adresse d'Infomaniak. Modifiable uniquement pour les tests.
const INFOMANIAK_BASE = process.env.INFOMANIAK_BASE_URL || "https://api.infomaniak.com";

/* ------------------------------------------------------------
   Choix du modèle

   Infomaniak renouvelle ses modèles : un modèle retiré reste utilisable
   30 jours, puis disparaît. Et un nom mal recopié (une majuscule, un espace)
   suffit à tout bloquer. Au démarrage, le serveur lit donc la liste exacte
   des modèles disponibles, retrouve celui qui est demandé même mal écrit, et
   s'il n'existe pas, en prend un de secours plutôt que de laisser l'app sans
   filtre. Tout est écrit dans les logs de Render.
   ------------------------------------------------------------ */

// Du meilleur au moins bon pour Tamisé. Sert seulement si le modèle demandé
// n'existe pas (ou plus).
const MODELES_DE_SECOURS = [
  "Qwen/Qwen3.5-122B-A10B-FP8",
  "mistralai/Mistral-Small-4-119B-2603",
  "mistral24b",
];

let modelesDisponibles = null;            // liste lue chez Infomaniak
let modeleEffectif = INFOMANIAK_MODEL || null;

async function lireModelesInfomaniak() {
  const r = await fetch(`${INFOMANIAK_BASE}/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1/models`, {
    headers: { Authorization: `Bearer ${INFOMANIAK_API_KEY}` },
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) throw new Error("HTTP " + r.status + " " + JSON.stringify(d).slice(0, 300));
  const liste = Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models : Array.isArray(d) ? d : [];
  return liste.map((m) => (typeof m === "string" ? m : m && (m.id || m.name || m.model))).filter(Boolean);
}

/** Retrouve un modèle même écrit avec d'autres majuscules ou des espaces. */
function trouverModele(nom, liste) {
  if (!nom || !liste) return null;
  if (liste.includes(nom)) return nom;
  const simple = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  return liste.find((m) => simple(m) === simple(nom)) || null;
}

async function choisirModele() {
  if (!INFOMANIAK_PRODUCT_ID || !INFOMANIAK_API_KEY) return;
  try {
    modelesDisponibles = await lireModelesInfomaniak();
  } catch (e) {
    console.error("Liste des modèles Infomaniak illisible :", e.message);
    return; // on garde le nom demandé tel quel
  }
  console.log("Modèles disponibles chez Infomaniak :", modelesDisponibles.join("  |  "));

  const trouve = trouverModele(INFOMANIAK_MODEL, modelesDisponibles);
  if (trouve) {
    if (trouve !== INFOMANIAK_MODEL) {
      console.log(`Modèle « ${INFOMANIAK_MODEL} » reconnu sous son nom exact « ${trouve} ».`);
    }
    modeleEffectif = trouve;
  } else {
    if (INFOMANIAK_MODEL) {
      console.error(
        `ATTENTION : le modèle « ${INFOMANIAK_MODEL} » (variable INFOMANIAK_MODEL sur Render) ` +
        "n'existe pas chez Infomaniak. Copie un nom exact depuis la page /api/modeles."
      );
    }
    const secours = MODELES_DE_SECOURS.map((m) => trouverModele(m, modelesDisponibles)).find(Boolean);
    if (secours) {
      modeleEffectif = secours;
      console.error("En attendant, modèle de secours utilisé :", secours);
    }
  }
  console.log("Modèle utilisé :", modeleEffectif || "(aucun)");
}

/** Réglages propres à certains modèles. */
function reglagesPourModele(modele) {
  const m = String(modele || "").toLowerCase();
  // Qwen « réfléchit à voix haute » par défaut avant de répondre : c'est plus
  // lent, plus cher, et la vraie réponse peut arriver coupée. On le désactive.
  if (m.includes("qwen")) return { chat_template_kwargs: { enable_thinking: false } };
  if (m.includes("mistral-small-4")) return { reasoning_effort: "none" };
  return {};
}

// Modèles capables de réfléchir avant de répondre. Si le réglage ci-dessus
// n'est pas pris en compte, on leur laisse de la marge pour que la réponse
// ne soit pas coupée. La marge ne coûte rien si elle ne sert pas.
const PEUT_REFLECHIR = /qwen|mistral-small-4|magistral|gpt-oss|kimi|deepseek|reason/i;

function estJSON(texte) {
  try { JSON.parse(texte); return true; } catch (e) { return false; }
}

let reflexionSignalee = false;
const reglagesRefuses = new Set();       // modèles pour lesquels Infomaniak refuse nos réglages

/** Rend une réponse propre à l'app : sans réflexion à voix haute et, quand
 *  l'app a demandé du JSON, avec le JSON seul — un mot de trop avant ou après
 *  suffisait à faire échouer la lecture, et l'app retombait alors sur son
 *  filtre de secours. */
function nettoyerReponse(donnees, demandeJSON, modele) {
  const choix = donnees && Array.isArray(donnees.choices) ? donnees.choices[0] : null;
  if (!choix || !choix.message) return;
  let texte = typeof choix.message.content === "string" ? choix.message.content : "";
  let reflechi = Boolean(choix.message.reasoning_content || choix.message.reasoning);

  for (const [ouvre, ferme] of [["<think>", "</think>"], ["[THINK]", "[/THINK]"]]) {
    const bas = texte.toLowerCase();
    if (!bas.includes(ouvre.toLowerCase()) && !bas.includes(ferme.toLowerCase())) continue;
    reflechi = true;
    const fin = bas.lastIndexOf(ferme.toLowerCase());
    if (fin !== -1) {
      texte = texte.slice(fin + ferme.length);                              // tout ce qui suit la réflexion
    } else {
      texte = texte.slice(0, bas.indexOf(ouvre.toLowerCase()));             // réflexion jamais refermée
    }
  }
  texte = texte.trim();

  if (demandeJSON) {
    const sansBalises = texte.replace(/```(?:json)?/gi, "").trim();
    if (estJSON(sansBalises)) {
      texte = sansBalises;
    } else {
      const debut = sansBalises.indexOf("{");
      const fin = sansBalises.lastIndexOf("}");
      if (debut !== -1 && fin > debut && estJSON(sansBalises.slice(debut, fin + 1))) {
        texte = sansBalises.slice(debut, fin + 1);
      }
    }
  }

  choix.message.content = texte;
  delete choix.message.reasoning_content; // inutile au téléphone, et lourd
  delete choix.message.reasoning;
  if (reflechi && !reflexionSignalee) {
    reflexionSignalee = true;
    console.warn(`Le modèle ${modele} réfléchit avant de répondre malgré le réglage : réponses plus lentes et plus chères.`);
  }
}

async function appelInfomaniak(corps) {
  const r = await fetch(`${INFOMANIAK_BASE}/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${INFOMANIAK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
  const donnees = await r.json().catch(() => ({ error: "Réponse illisible d'Infomaniak (HTTP " + r.status + ")" }));
  return { ok: r.ok, status: r.status, donnees };
}

function modeleInconnu(rep) {
  if (rep.status === 404) return true;
  const t = JSON.stringify(rep.donnees || "").toLowerCase();
  return t.includes("model") && /not found|unknown|invalid|does not exist|not exist|not available|introuvable|inconnu/.test(t);
}

/** Envoie une demande à l'IA avec le bon modèle et ses réglages.
 *  - Si Infomaniak refuse un réglage qu'il ne connaît pas, réessaie sans, et
 *    ne le renvoie plus jamais pour ce modèle.
 *  - Si le modèle est inconnu (mal écrit, ou retiré entre-temps), relit la
 *    liste et réessaie une fois avec le bon nom ou un modèle de secours. */
async function demanderIA(demande) {
  const essayer = async (nom) => {
    const reglages = reglagesRefuses.has(nom) ? {} : reglagesPourModele(nom);
    let corps = { ...demande, model: nom, ...reglages };
    if (PEUT_REFLECHIR.test(nom) && corps.max_tokens) corps.max_tokens = corps.max_tokens + 1500;
    let rep = await appelInfomaniak(corps);
    if (!rep.ok && Object.keys(reglages).length && (rep.status === 400 || rep.status === 422)) {
      const sans = { ...corps };
      Object.keys(reglages).forEach((k) => delete sans[k]);
      const rep2 = await appelInfomaniak(sans);
      if (rep2.ok) {
        reglagesRefuses.add(nom);
        console.error(`Infomaniak refuse le réglage ${Object.keys(reglages).join(", ")} pour ${nom} : envoyé sans désormais.`, JSON.stringify(rep.donnees).slice(0, 300));
      }
      rep = rep2;
      corps = sans;
    }
    return { rep, corps };
  };

  const modele = modeleEffectif || demande.model;
  let { rep, corps } = await essayer(modele);
  if (!rep.ok && modeleInconnu(rep)) {
    console.error(`Modèle « ${modele} » refusé par Infomaniak :`, JSON.stringify(rep.donnees).slice(0, 400));
    await choisirModele();
    if (modeleEffectif && modeleEffectif !== modele) {
      ({ rep, corps } = await essayer(modeleEffectif));
    }
  }
  return { rep, corps };
}

/** Traduit un refus d'Infomaniak en une phrase simple. */
function expliquerErreur(status, detail) {
  const t = String(detail || "").toLowerCase();
  if (/cr[eé]dit\b|cr[eé]dits|payment|paiement|billing|factur|balance|solde|insufficient (funds|credit|balance)/.test(t) || status === 402) {
    return "Infomaniak parle de paiement ou de crédit : ton crédit est sans doute épuisé, ou un paiement est en attente.";
  }
  if (status === 401 || status === 403) {
    return "Infomaniak refuse la clé : vérifie que INFOMANIAK_API_KEY sur Render est recopiée en entier, toujours valide, et qu'elle a le droit d'utiliser l'IA.";
  }
  if (status === 404) return "Infomaniak ne trouve pas le modèle ou le produit : vérifie INFOMANIAK_MODEL et INFOMANIAK_PRODUCT_ID.";
  if (status === 429 || /quota|spending|plafond|limit (reached|exceeded)/.test(t)) {
    return "Une limite est atteinte (trop de demandes d'un coup, ou plafond de dépenses). Réessaie dans une minute.";
  }
  if (status >= 500) return "Infomaniak a un problème de son côté. Réessaie dans quelques minutes.";
  if (status === 0) return "Le serveur n'arrive pas à joindre Infomaniak.";
  return "Infomaniak a refusé la demande.";
}

// Le test de la page de contrôle coûte quelques millièmes de centime. On le
// garde une minute en mémoire pour qu'on ne puisse pas le relancer en boucle.
let dernierTest = null;

async function testerIA() {
  if (dernierTest && Date.now() - dernierTest.quand < 60 * 1000) return dernierTest.resultat;
  let resultat;
  try {
    const { rep, corps } = await demanderIA({
      messages: [{ role: "user", content: "Réponds seulement : OK" }],
      max_tokens: 10,
      temperature: 0,
    });
    if (rep.ok) {
      nettoyerReponse(rep.donnees, false, corps.model);
      resultat = { ok: true, modele: corps.model };
    } else {
      const detail = JSON.stringify(rep.donnees).slice(0, 300);
      console.error(`Test de la page /api/modeles refusé par Infomaniak (HTTP ${rep.status}, modèle ${corps.model}) :`, detail);
      resultat = { ok: false, modele: corps.model, status: rep.status, detail, explication: expliquerErreur(rep.status, detail) };
    }
  } catch (e) {
    resultat = { ok: false, status: 0, detail: e.message, explication: expliquerErreur(0, e.message) };
  }
  dernierTest = { quand: Date.now(), resultat };
  return resultat;
}

/* ============================================================
   BASE DE DONNÉES (MySQL)
   ============================================================ */

let pool = null;

/**
 * Crée la base de données si elle n'existe pas encore.
 * Certains hébergeurs (dont Infomaniak) livrent un serveur MySQL vide, sans
 * base à l'intérieur : on se connecte alors au serveur seul, on crée la base,
 * puis on s'y connecte normalement.
 */
async function preparerBase() {
  if (!process.env.DATABASE_URL) return;

  const url = new URL(process.env.DATABASE_URL);
  const nomBase = url.pathname.replace(/^\//, "") || "tamise";

  // 1. Connexion au serveur seul (sans nom de base), pour pouvoir la créer.
  const connexion = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port) || 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: false },
  });
  await connexion.query(
    "CREATE DATABASE IF NOT EXISTS `" + nomBase.replace(/`/g, "") + "` " +
    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  );
  await connexion.end();
  console.log(`Base « ${nomBase} » prête.`);

  // 2. Connexion normale, cette fois sur la base elle-même.
  pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // les bases managées imposent une connexion TLS
    waitForConnections: true,
    connectionLimit: 5,
  });
}

async function initBase() {
  await preparerBase();
  if (!pool) {
    console.warn("DATABASE_URL absent : le partage entre téléphones est désactivé.");
    return;
  }
  // Note : MySQL n'accepte pas "CREATE INDEX IF NOT EXISTS",
  // l'index est donc déclaré directement dans la table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relations (
      id         VARCHAR(36)  NOT NULL PRIMARY KEY,
      code       VARCHAR(12)  NOT NULL UNIQUE,
      type       VARCHAR(32)  NULL,
      nom_a      VARCHAR(120) NULL,
      mon_nom_a  VARCHAR(120) NULL,
      nom_b      VARCHAR(120) NULL,
      jumelee    TINYINT(1)   NOT NULL DEFAULT 0,
      cree_le    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Migration sûre pour une base déjà existante (créée avant l'ajout de mon_nom_a) :
  // nom_a est le nom que la personne A donne à SA relation (souvent le prénom de
  // l'autre) — mon_nom_a est le vrai prénom de la personne A elle-même, nécessaire
  // pour que la personne qui rejoint sache qui l'a invitée, et non son propre prénom.
  //
  // On ne se fie PAS à « ADD COLUMN IF NOT EXISTS » : cette syntaxe n'est pas
  // reconnue par toutes les versions de MySQL, et quand elle échoue le serveur
  // continue sans la colonne — puis chaque création de relation plante avec
  // « Unknown column 'mon_nom_a' ». On vérifie donc d'abord si la colonne existe,
  // et on l'ajoute seulement si besoin.
  try {
    const [colonnes] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'relations' AND COLUMN_NAME = 'mon_nom_a'"
    );
    if (colonnes.length === 0) {
      await pool.query("ALTER TABLE relations ADD COLUMN mon_nom_a VARCHAR(120) NULL");
      console.log("Colonne mon_nom_a ajoutée à la table relations.");
    }
  } catch (e) {
    console.error("Migration mon_nom_a : échec —", e.message);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS elements (
      id           BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
      relation_id  VARCHAR(36) NOT NULL,
      type         VARCHAR(32) NOT NULL,
      auteur       VARCHAR(32) NOT NULL,
      contenu      JSON        NOT NULL,
      cree_le      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_elements_relation (relation_id, id),
      CONSTRAINT fk_elements_relation FOREIGN KEY (relation_id)
        REFERENCES relations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  // Qui a quitté la relation. Tant qu'une seule des deux personnes est partie,
  // on garde tout : l'autre a le droit de conserver ses échanges et surtout les
  // preuves qu'elle a archivées. Effacer sur simple demande de l'un reviendrait
  // à laisser n'importe qui supprimer les traces de ce qu'il a écrit.
  try {
    const [col] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'relations' AND COLUMN_NAME = 'quittee_par'"
    );
    if (col.length === 0) {
      await pool.query("ALTER TABLE relations ADD COLUMN quittee_par TEXT NULL");
      console.log("Colonne quittee_par ajoutée à la table relations.");
    }
  } catch (e) {
    console.error("Migration quittee_par : échec —", e.message);
  }

  // Texte extrait des documents ajoutés par les personnes.
  // On ne garde QUE le texte : le fichier d'origine, lui, reste sur le téléphone.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
      relation_id  VARCHAR(36)  NOT NULL,
      doc_id       VARCHAR(64)  NOT NULL,
      nom          VARCHAR(255) NULL,
      texte        LONGTEXT     NULL,
      cree_le      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_doc (relation_id, doc_id),
      CONSTRAINT fk_documents_relation FOREIGN KEY (relation_id)
        REFERENCES relations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Boîte aux lettres des photos de la conversation (décision 043).
  // « donnees » est la photo CHIFFRÉE par le téléphone de l'expéditeur, avec
  // une clé que seuls les deux téléphones connaissent : le serveur ne peut
  // pas la regarder. La ligne est effacée dès que l'autre téléphone l'a
  // récupérée, et au plus tard 7 jours après (voir la purge plus bas).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boite (
      id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
      relation_id  VARCHAR(36)  NOT NULL,
      photo_id     VARCHAR(64)  NOT NULL,
      donnees      LONGTEXT     NOT NULL,
      cree_le      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_photo (relation_id, photo_id),
      CONSTRAINT fk_boite_relation FOREIGN KEY (relation_id)
        REFERENCES relations(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  console.log("Base de données prête.");

  // Purge des codes jamais utilisés après 7 jours : sans ce nettoyage, un
  // code oublié resterait jumelable indéfiniment, même bien après que la
  // personne qui l'a envoyé n'y pense plus.
  async function purgerCodesExpires() {
    try {
      const [r] = await pool.query(
        "DELETE FROM relations WHERE jumelee = 0 AND cree_le < (NOW() - INTERVAL 7 DAY)"
      );
      if (r.affectedRows) console.log(`${r.affectedRows} code(s) de jumelage expiré(s) purgé(s).`);
    } catch (e) {
      console.error("Purge des codes expirés : échec —", e.message);
    }
    // Une photo que l'autre téléphone n'est jamais venu chercher ne reste
    // pas plus de 7 jours dans la boîte aux lettres.
    try {
      const [r] = await pool.query("DELETE FROM boite WHERE cree_le < (NOW() - INTERVAL 7 DAY)");
      if (r.affectedRows) console.log(`${r.affectedRows} photo(s) jamais récupérée(s) effacée(s) de la boîte aux lettres.`);
    } catch (e) {
      console.error("Purge de la boîte aux lettres : échec —", e.message);
    }
  }
  purgerCodesExpires();
  setInterval(purgerCodesExpires, 6 * 60 * 60 * 1000); // toutes les 6 heures
}

/** Code de jumelage court, sans caractères ambigus (ni O/0, ni I/1). */
function genererCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[crypto.randomInt(alphabet.length)];
  }
  return code;
}

function exigerBase(res) {
  if (!pool) {
    res.status(503).json({ error: "Base de données non configurée sur le serveur." });
    return false;
  }
  return true;
}

/* ============================================================
   ROUTES — état du serveur
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    statut: "Serveur Tamisé en ligne",
    ia: Boolean(INFOMANIAK_API_KEY && INFOMANIAK_PRODUCT_ID),
    partage: Boolean(pool),
  });
});

/* ============================================================
   ROUTES — jumelage de deux téléphones
   ============================================================ */

/** Crée une relation et renvoie le code à transmettre à l'autre personne. */
app.post("/api/relations", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { nom, type, monNom } = req.body || {};
    const id = crypto.randomUUID();

    // On réessaie si le code tiré est déjà pris (très improbable).
    let code = null;
    for (let essai = 0; essai < 5; essai++) {
      const candidat = genererCode();
      const [dejaPris] = await pool.query("SELECT 1 FROM relations WHERE code = ?", [candidat]);
      if (dejaPris.length === 0) { code = candidat; break; }
    }
    if (!code) return res.status(500).json({ error: "Impossible de générer un code." });

    await pool.query(
      "INSERT INTO relations (id, code, type, nom_a, mon_nom_a) VALUES (?, ?, ?, ?, ?)",
      [id, code, type || null, nom || null, monNom || null]
    );
    res.json({ relationId: id, code });
  } catch (e) {
    console.error("Erreur création de relation :", e);
    res.status(500).json({ error: "Création impossible." });
  }
});

/** Rejoint une relation existante à partir du code reçu. */
app.post("/api/relations/rejoindre", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { code, nom } = req.body || {};
    if (!code) return res.status(400).json({ error: "Code manquant." });

    const [lignes] = await pool.query(
      "SELECT id, type, nom_a, mon_nom_a, jumelee, cree_le FROM relations WHERE code = ?",
      [String(code).trim().toUpperCase()]
    );
    if (lignes.length === 0) return res.status(404).json({ error: "Code inconnu." });

    const rel = lignes[0];
    if (rel.jumelee) {
      return res.status(409).json({ error: "Cette relation est déjà reliée à un autre téléphone." });
    }

    // Un code non utilisé n'a pas vocation à rester valable indéfiniment : ce
    // serait un code qui traîne, potentiellement intercepté ou envoyé par
    // erreur, et toujours jumelable des mois plus tard sans que personne s'en
    // souvienne. Passé 7 jours sans avoir été utilisé, on l'efface plutôt que
    // de le laisser orphelin en base, et on le dit clairement.
    const ageJours = (Date.now() - new Date(rel.cree_le).getTime()) / 86400000;
    if (ageJours > 7) {
      await pool.query("DELETE FROM relations WHERE id = ?", [rel.id]);
      return res.status(410).json({ error: "Ce code a expiré (plus de 7 jours). Demande-en un nouveau." });
    }

    await pool.query(
      "UPDATE relations SET jumelee = 1, nom_b = ? WHERE id = ?",
      [nom || null, rel.id]
    );
    // mon_nom_a = le vrai prénom de la personne qui a invité. À défaut (bases
    // créées avant cet ajout), on retombe sur nom_a pour ne rien casser.
    res.json({ relationId: rel.id, type: rel.type, nomAutre: rel.mon_nom_a || rel.nom_a });
  } catch (e) {
    console.error("Erreur de jumelage :", e);
    res.status(500).json({ error: "Jumelage impossible." });
  }
});

/** Informations d'une relation (utile pour savoir si l'autre a rejoint). */
app.get("/api/relations/:id", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const [lignes] = await pool.query(
      "SELECT id, code, type, nom_a, nom_b, jumelee FROM relations WHERE id = ?",
      [req.params.id]
    );
    if (lignes.length === 0) return res.status(404).json({ error: "Relation inconnue." });
    const rel = lignes[0];
    res.json({ ...rel, jumelee: Boolean(rel.jumelee) });
  } catch (e) {
    console.error("Erreur lecture relation :", e);
    res.status(500).json({ error: "Lecture impossible." });
  }
});

/* ============================================================
   ROUTES — contenus partagés (messages, agenda, dépenses…)
   ============================================================ */

/** Ajoute un élément partagé. */
app.post("/api/relations/:id/elements", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { type, auteur, contenu } = req.body || {};
    if (!type || !auteur || contenu === undefined) {
      return res.status(400).json({ error: "type, auteur et contenu sont requis." });
    }
    // MySQL ne connaît pas "RETURNING" : on insère, puis on relit la ligne créée.
    const [resultat] = await pool.query(
      "INSERT INTO elements (relation_id, type, auteur, contenu) VALUES (?, ?, ?, ?)",
      [req.params.id, type, auteur, JSON.stringify(contenu)]
    );
    const [lignes] = await pool.query(
      "SELECT id, type, auteur, contenu, cree_le FROM elements WHERE id = ?",
      [resultat.insertId]
    );
    res.json(lignes[0]);
  } catch (e) {
    console.error("Erreur ajout d'élément :", e);
    res.status(500).json({ error: "Ajout impossible." });
  }
});

/**
 * Récupère les éléments partagés.
 * ?depuis=<id>  ne renvoie que ce qui est plus récent que cet identifiant,
 * ce qui permet à l'application de vérifier régulièrement s'il y a du nouveau
 * sans tout retélécharger.
 */
app.get("/api/relations/:id/elements", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const depuis = Number(req.query.depuis) || 0;
    const [lignes] = await pool.query(
      `SELECT id, type, auteur, contenu, cree_le
         FROM elements
        WHERE relation_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT 500`,
      [req.params.id, depuis]
    );
    res.json({
      elements: lignes,
      dernierId: lignes.length ? lignes[lignes.length - 1].id : depuis,
    });
  } catch (e) {
    console.error("Erreur lecture des éléments :", e);
    res.status(500).json({ error: "Lecture impossible." });
  }
});

/* ============================================================
   ROUTES — documents (extraction du texte et recherche)

   Pourquoi ici et pas sur le téléphone : un jugement de divorce fait
   couramment 200 pages. C'est trop lourd pour la mémoire d'un téléphone, et
   bien trop long pour être envoyé d'un coup à l'IA. On extrait donc le texte
   une seule fois, on le garde, et on ne renvoie que les passages qui
   répondent à la question posée.
   ============================================================ */

/** Découpe un long texte en morceaux qui se chevauchent un peu, pour ne pas
 *  couper en deux une phrase importante. */
function decouperEnMorceaux(texte, taille = 1200, chevauchement = 200) {
  const propre = (texte || "").replace(/\s+/g, " ").trim();
  const morceaux = [];
  if (!propre) return morceaux;
  for (let i = 0; i < propre.length; i += taille - chevauchement) {
    morceaux.push(propre.slice(i, i + taille));
    if (i + taille >= propre.length) break;
  }
  return morceaux;
}

/** Mots trop courants pour être utiles : ils ressortiraient partout et
 *  fausseraient complètement le classement des passages. */
const MOTS_VIDES = new Set(["le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "que", "qui", "quoi", "est", "sont", "dans", "pour", "avec", "sur", "au", "aux", "ce", "cette", "ces", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "il", "elle", "je", "tu", "nous", "vous", "ils", "elles", "ne", "pas", "plus", "moins", "en", "par", "se", "si", "me", "te", "lui", "leur", "on", "dit", "fait", "peux", "peut", "dois", "doit", "avoir", "etre", "faire", "cela", "donc", "mais", "comme", "tout", "tous", "toute"]);

/** Mots utiles d'une question, sans accents ni ponctuation. */
function motsUtiles(question) {
  return Array.from(new Set(
    (question || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((m) => m.length > 2 && !MOTS_VIDES.has(m))
  ));
}

/** Reçoit un document, en extrait le texte, et le range. */
app.post("/api/relations/:id/documents", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { docId, nom, dataUrl } = req.body || {};
    if (!docId || !dataUrl) {
      return res.status(400).json({ error: "docId et dataUrl sont requis." });
    }

    // Le fichier arrive encodé en base64, précédé de son type.
    const base64 = String(dataUrl).split(",").pop();
    const binaire = Buffer.from(base64, "base64");

    if (!String(dataUrl).startsWith("data:application/pdf")) {
      // Photo d'un document : on ne sait pas encore y lire le texte.
      return res.json({ ok: true, lisible: false, raison: "Seuls les PDF sont lus pour l'instant." });
    }

    const resultat = await pdfParse(binaire);
    const texte = resultat.text || "";

    if (!texte.trim()) {
      return res.json({
        ok: true,
        lisible: false,
        raison: "Ce PDF ne contient pas de texte : c'est probablement un scan ou une photo.",
      });
    }

    await pool.query(
      "INSERT INTO documents (relation_id, doc_id, nom, texte) VALUES (?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE nom = VALUES(nom), texte = VALUES(texte)",
      [req.params.id, docId, nom || null, texte]
    );
    res.json({ ok: true, lisible: true, caracteres: texte.length });
  } catch (e) {
    console.error("Erreur extraction document :", e);
    res.status(500).json({ error: "Lecture du document impossible." });
  }
});

/** Renvoie les passages des documents qui répondent le mieux à la question. */
app.post("/api/relations/:id/documents/recherche", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { question } = req.body || {};
    const mots = motsUtiles(question);
    if (mots.length === 0) return res.json({ extraits: [] });

    const [docs] = await pool.query(
      "SELECT doc_id, nom, texte FROM documents WHERE relation_id = ?",
      [req.params.id]
    );

    const candidats = [];
    for (const doc of docs) {
      for (const morceau of decouperEnMorceaux(doc.texte)) {
        const compare = morceau.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        // Un passage vaut d'autant plus qu'il contient de mots DIFFÉRENTS de
        // la question — pas seulement le même mot répété plusieurs fois.
        let score = 0;
        for (const mot of mots) if (compare.includes(mot)) score++;
        if (score > 0) candidats.push({ nom: doc.nom || "Document", texte: morceau, score });
      }
    }

    candidats.sort((a, b) => b.score - a.score);
    res.json({ extraits: candidats.slice(0, 4).map(({ nom, texte }) => ({ nom, texte })) });
  } catch (e) {
    console.error("Erreur recherche documents :", e);
    res.status(500).json({ error: "Recherche impossible." });
  }
});

/** Supprime le texte d'un document (quand il est retiré de l'application). */
app.delete("/api/relations/:id/documents/:docId", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    await pool.query(
      "DELETE FROM documents WHERE relation_id = ? AND doc_id = ?",
      [req.params.id, req.params.docId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Erreur suppression document :", e);
    res.status(500).json({ error: "Suppression impossible." });
  }
});

/* ============================================================
   ROUTES — boîte aux lettres des photos de la conversation (décision 043)

   Le téléphone qui envoie dépose la photo CHIFFRÉE ; celui qui reçoit vient
   la chercher, la range chez lui, puis demande qu'elle soit effacée. Le
   serveur ne voit jamais qu'un bloc illisible, et ne le garde pas.
   ============================================================ */

app.post("/api/relations/:id/boite", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const { photoId, donnees } = req.body || {};
    if (!photoId || typeof donnees !== "string" || !donnees) {
      return res.status(400).json({ error: "photoId et donnees sont requis." });
    }
    // Une photo réduite par l'application pèse quelques centaines de Ko.
    if (donnees.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Photo trop lourde." });
    await pool.query(
      "INSERT INTO boite (relation_id, photo_id, donnees) VALUES (?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE donnees = VALUES(donnees)",
      [req.params.id, String(photoId).slice(0, 64), donnees]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Erreur dépôt de photo :", e.message);
    res.status(500).json({ error: "Dépôt impossible." });
  }
});

app.get("/api/relations/:id/boite/:photoId", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const [lignes] = await pool.query(
      "SELECT donnees FROM boite WHERE relation_id = ? AND photo_id = ?",
      [req.params.id, req.params.photoId]
    );
    if (!lignes.length) return res.status(404).json({ error: "Photo absente : déjà récupérée, ou plus de 7 jours." });
    res.json({ donnees: lignes[0].donnees });
  } catch (e) {
    console.error("Erreur lecture de photo :", e.message);
    res.status(500).json({ error: "Lecture impossible." });
  }
});

app.delete("/api/relations/:id/boite/:photoId", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    await pool.query("DELETE FROM boite WHERE relation_id = ? AND photo_id = ?", [req.params.id, req.params.photoId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Erreur effacement de photo :", e.message);
    res.status(500).json({ error: "Effacement impossible." });
  }
});

/** Efface une relation et TOUT ce qu'elle contient.
 *  Les messages, l'agenda, les dépenses et les documents partent avec elle :
 *  les clés étrangères sont déclarées ON DELETE CASCADE. C'est le droit à
 *  l'effacement du RGPD — il faut qu'il ne reste vraiment rien. */
app.delete("/api/relations/:id", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const appareil = String((req.query && req.query.appareil) || "").slice(0, 64);

    const [lignes] = await pool.query(
      "SELECT jumelee, quittee_par FROM relations WHERE id = ?",
      [req.params.id]
    );
    if (lignes.length === 0) return res.json({ ok: true, efface: true });

    const rel = lignes[0];
    let partis = [];
    try { partis = JSON.parse(rel.quittee_par || "[]"); } catch (e) { partis = []; }
    if (appareil && !partis.includes(appareil)) partis.push(appareil);

    // Jamais reliée à un second téléphone, ou les deux personnes sont parties :
    // plus personne n'en a l'usage, on efface tout (cascade sur les éléments
    // et les documents).
    if (!rel.jumelee || partis.length >= 2 || !appareil) {
      await pool.query("DELETE FROM relations WHERE id = ?", [req.params.id]);
      return res.json({ ok: true, efface: true });
    }

    await pool.query("UPDATE relations SET quittee_par = ? WHERE id = ?", [JSON.stringify(partis), req.params.id]);
    res.json({ ok: true, efface: false });
  } catch (e) {
    console.error("Erreur en quittant la relation :", e);
    res.status(500).json({ error: "Opération impossible." });
  }
});

/* ============================================================
   ROUTE — agenda auquel on s'abonne (.ics)

   Google Agenda, l'app Calendrier d'iPhone et Outlook savent tous s'abonner à
   une adresse qui renvoie un calendrier, et la relisent régulièrement d'eux-
   mêmes. Un événement confirmé dans Tamisé apparaît donc chez les deux
   personnes sans que personne n'ait rien à réimporter.

   L'adresse contient l'identifiant de la relation, tiré au hasard et donc
   impossible à deviner. Elle reste néanmoins SECRÈTE : qui l'obtient peut lire
   l'agenda. C'est le fonctionnement normal des agendas partagés, mais il faut
   le dire clairement aux personnes.

   Seuls les événements CONFIRMÉS sortent d'ici : ce qui attend encore l'accord
   de l'autre ne part pas dans son calendrier.
   ============================================================ */

function echapperICS(txt) {
  return String(txt || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function dateICS(iso, jourEntier) {
  const propre = String(iso || "").replace(/[-:]/g, "");
  if (jourEntier) return propre.slice(0, 8);
  const [d, h] = propre.split("T");
  return d + "T" + (h || "0900").padEnd(6, "0");
}

app.get("/api/agenda/:relationId.ics", async (req, res) => {
  if (!exigerBase(res)) return;
  try {
    const [lignes] = await pool.query(
      "SELECT type, contenu FROM elements WHERE relation_id = ? ORDER BY id ASC",
      [req.params.relationId]
    );

    // On rejoue l'historique : les ajouts d'événements, puis les modifications
    // (confirmation, changement d'horaire…) dans l'ordre où elles ont eu lieu.
    const parId = new Map();
    for (const l of lignes) {
      const c = typeof l.contenu === "string" ? JSON.parse(l.contenu) : l.contenu;
      if (!c) continue;
      if (l.type === "agenda" && c.id) parId.set(c.id, { ...c });
      if (l.type === "maj" && c.champ === "agenda" && c.id) {
        if (c.supprimerElement) { parId.delete(c.id); continue; }
        const actuel = parId.get(c.id);
        if (actuel) parId.set(c.id, { ...actuel, ...(c.patch || c.patchElement || {}) });
      }
    }

    const evenements = [...parId.values()].filter((e) => e && e.start && e.statut === "confirme");

    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tamise//FR", "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH", "X-WR-CALNAME:Tamisé", "X-PUBLISHED-TTL:PT1H",
      "REFRESH-INTERVAL;VALUE=DURATION:PT1H"];
    for (const e of evenements) {
      const jourEntier = !!e.allDay;
      ics.push("BEGIN:VEVENT");
      ics.push("UID:" + e.id + "@tamise");
      ics.push("DTSTAMP:" + dateICS(new Date().toISOString().slice(0, 16), false) + "Z");
      if (jourEntier) {
        ics.push("DTSTART;VALUE=DATE:" + dateICS(e.start, true));
        ics.push("DTEND;VALUE=DATE:" + dateICS(e.end || e.start, true));
      } else {
        ics.push("DTSTART:" + dateICS(e.start, false));
        ics.push("DTEND:" + dateICS(e.end || e.start, false));
      }
      ics.push("SUMMARY:" + echapperICS(e.titre));
      if (e.cat) ics.push("CATEGORIES:" + echapperICS(e.cat));
      if (e.recurrence === "semaine") ics.push("RRULE:FREQ=WEEKLY");
      if (e.recurrence === "quinzaine") ics.push("RRULE:FREQ=WEEKLY;INTERVAL=2");
      if (e.recurrence === "mois") ics.push("RRULE:FREQ=MONTHLY");
      ics.push("END:VEVENT");
    }
    ics.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "no-cache");
    res.send(ics.join("\r\n"));
  } catch (e) {
    console.error("Erreur agenda .ics :", e);
    res.status(500).send("Agenda indisponible.");
  }
});

/* ============================================================
   ROUTE — textes de loi de référence

   Iris n'a pas internet : sans ces textes, elle répondrait de mémoire et
   inventerait des numéros d'article. Elle ne peut citer que ce qui est écrit
   dans textes-loi.js. Les entrées non remplies sont ignorées.
   ============================================================ */

/** Textes réellement disponibles (ceux dont le contenu a été copié). */
const TEXTES_REMPLIS = (TEXTES_LOI || []).filter((t) => t && t.texte && t.texte.trim().length > 30);
console.log(`Textes de loi disponibles : ${TEXTES_REMPLIS.length} / ${(TEXTES_LOI || []).length}`);

app.post("/api/textes-loi/recherche", (req, res) => {
  try {
    const { question } = req.body || {};
    const mots = motsUtiles(question);
    if (mots.length === 0 || TEXTES_REMPLIS.length === 0) return res.json({ extraits: [] });

    const candidats = [];
    for (const t of TEXTES_REMPLIS) {
      // On cherche dans le titre ET dans le texte : le titre porte souvent le
      // mot que la personne emploie (« pension », « déménagement »).
      // Les mots-clés et le titre pèsent plus lourd que le corps de l'article :
      // ils sont écrits avec les mots que les gens emploient réellement, alors
      // que le texte de loi a un vocabulaire que personne n'utilise pour poser
      // sa question (« contribution à l'entretien » plutôt que « pension »).
      const cles = ((t.motsCles || "") + " " + t.titre + " " + t.domaine)
        .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const corps = (t.texte || "")
        .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      let score = 0;
      for (const mot of mots) {
        if (cles.includes(mot)) score += 3;
        else if (corps.includes(mot)) score += 1;
      }
      if (score > 0) candidats.push({ source: t.source, titre: t.titre, texte: t.texte, score });
    }
    candidats.sort((a, b) => b.score - a.score);
    res.json({ extraits: candidats.slice(0, 3).map(({ source, titre, texte }) => ({ source, titre, texte })) });
  } catch (e) {
    console.error("Erreur recherche textes de loi :", e);
    res.status(500).json({ error: "Recherche impossible." });
  }
});

/* ============================================================
   PAGE DE CONTRÔLE — quels modèles sont disponibles ?

   À ouvrir dans Safari : https://tamise-backend.onrender.com/api/modeles
   Elle affiche le modèle utilisé en ce moment, et la liste exacte des noms
   à copier-coller dans la variable INFOMANIAK_MODEL de Render. Elle ne
   montre aucune clé ni aucune donnée personnelle.
   ============================================================ */

app.get("/api/modeles", async (req, res) => {
  const echapper = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let liste = [];
  let erreur = "";
  if (!INFOMANIAK_PRODUCT_ID || !INFOMANIAK_API_KEY) {
    erreur = "INFOMANIAK_PRODUCT_ID ou INFOMANIAK_API_KEY manque dans les variables de Render.";
  } else {
    try {
      liste = await lireModelesInfomaniak();
      modelesDisponibles = liste;
    } catch (e) {
      erreur = "Liste illisible : " + e.message;
    }
  }
  const test = INFOMANIAK_PRODUCT_ID && INFOMANIAK_API_KEY ? await testerIA() : null;
  const lignes = liste.map((nom) => `
    <li><code>${echapper(nom)}</code>
      <button data-nom="${echapper(nom)}" onclick="navigator.clipboard.writeText(this.dataset.nom).then(() => { this.textContent = 'Copié ✓'; })">Copier</button></li>`).join("");
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Modèles d'IA — Tamisé</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #F7F3EC; color: #3B3631; margin: 0; padding: 20px 16px 40px; line-height: 1.45; }
  h1 { font-size: 20px; margin: 0 0 14px; }
  .carte { background: #fff; border-radius: 16px; padding: 14px 16px; margin-bottom: 16px; }
  .petit { font-size: 13px; color: #7A7068; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid #EEE7DD; }
  li:last-child { border-bottom: none; }
  code { font-size: 14px; word-break: break-all; }
  button { flex-shrink: 0; border: none; border-radius: 999px; padding: 8px 14px; background: #7D6E62; color: #fff; font-size: 13px; font-weight: 600; }
  .erreur { color: #A4483A; }
  .ok { color: #4F7A4A; font-weight: 600; }
  p { margin: 6px 0 0; }
</style></head><body>
<h1>Modèles d'IA</h1>
<div class="carte">
  <div class="petit">L'IA répond-elle ?</div>
  ${!test
    ? `<p class="erreur">Test impossible : ${echapper(erreur)}</p>`
    : test.ok
      ? `<p class="ok">✓ Oui. Le modèle <code>${echapper(test.modele)}</code> a répondu.</p>`
      : `<p class="erreur">✗ Non. ${echapper(test.explication)}</p>
         <p class="petit">Détail technique${test.status ? " (HTTP " + test.status + ")" : ""} : <code>${echapper(test.detail || "")}</code></p>`}
</div>
<div class="carte">
  <div class="petit">Modèle utilisé en ce moment</div>
  <div><code>${echapper(modeleEffectif || "(aucun)")}</code></div>
  ${INFOMANIAK_MODEL && modeleEffectif !== INFOMANIAK_MODEL
    ? (trouverModele(INFOMANIAK_MODEL, liste)
        ? `<p class="petit">Tu as écrit <code>${echapper(INFOMANIAK_MODEL)}</code> : il est reconnu, mais tu peux recopier le nom exact ci-dessous.</p>`
        : `<p class="petit erreur">Tu as demandé <code>${echapper(INFOMANIAK_MODEL)}</code> : ce nom n'existe pas chez Infomaniak, un modèle de secours le remplace. Copie un nom exact ci-dessous.</p>`)
    : ""}
</div>
<div class="carte">
  <div class="petit" style="margin-bottom:6px">Noms exacts disponibles — copie celui que tu veux dans la variable INFOMANIAK_MODEL de Render</div>
  ${erreur ? `<p class="erreur">${echapper(erreur)}</p>` : `<ul>${lignes}</ul>`}
</div>
</body></html>`);
});

/* ============================================================
   ROUTE — intelligence artificielle (Infomaniak)
   ============================================================ */

app.post("/api/ia", async (req, res) => {
  if (!INFOMANIAK_PRODUCT_ID || !INFOMANIAK_API_KEY) {
    return res.status(500).json({
      error: "Configuration manquante : INFOMANIAK_PRODUCT_ID ou INFOMANIAK_API_KEY absent des variables d'environnement de Render.",
    });
  }

  try {
    // Le modèle choisi par le serveur prime sur celui envoyé par l'application.
    const messages = (req.body && req.body.messages) || [];
    const demandeJSON = messages.some((m) => m && typeof m.content === "string" && m.content.includes("JSON"));
    const { rep, corps } = await demanderIA(req.body || {});

    if (!rep.ok) {
      console.error(`Erreur Infomaniak (modèle ${corps.model}) :`, JSON.stringify(rep.donnees).slice(0, 600));
      return res.status(rep.status).json(rep.donnees);
    }

    nettoyerReponse(rep.donnees, demandeJSON, corps.model);
    res.json(rep.donnees);
  } catch (erreur) {
    console.error("Erreur serveur en appelant Infomaniak :", erreur);
    res.status(500).json({ error: "Impossible de joindre l'IA pour le moment." });
  }
});

/* ============================================================ */

const PORT = process.env.PORT || 3000;
initBase()
  .catch((e) => console.error("Erreur d'initialisation de la base :", e))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Serveur Tamisé démarré sur le port ${PORT}`);
    });
    // Vérifie le modèle d'IA demandé et note dans les logs ceux qui existent.
    choisirModele().catch((e) => console.error("Choix du modèle impossible :", e));
  });
