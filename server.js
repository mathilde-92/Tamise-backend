/**
 * Serveur backend de Tamisé — à déployer sur Render.
 *
 * Trois rôles :
 *  1. Garder la clé API Infomaniak en sécurité et relayer les demandes d'IA.
 *  2. Stocker les données partagées d'une relation (messages, agenda, dépenses…)
 *     pour que deux téléphones voient la même chose.
 *  3. Extraire le texte des documents ajoutés (PDF) et retrouver, dans ce
 *     texte, les passages qui répondent à une question posée à Iris.
 *
 * Base de données : MySQL (service managé Infomaniak, hébergé en Suisse).
 *
 * Variables d'environnement attendues sur Render :
 *   INFOMANIAK_PRODUCT_ID   ton identifiant produit AI Services
 *   INFOMANIAK_API_KEY      ton token API Infomaniak
 *   INFOMANIAK_MODEL        le nom du modèle (ex. mistral24b)
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

const INFOMANIAK_PRODUCT_ID = process.env.INFOMANIAK_PRODUCT_ID;
const INFOMANIAK_API_KEY = process.env.INFOMANIAK_API_KEY;
// Modèle utilisé. Défini ici (côté serveur) plutôt que dans l'application :
// ça permet d'en changer sans avoir à reconstruire tout le site.
const INFOMANIAK_MODEL = process.env.INFOMANIAK_MODEL;

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
  try {
    await pool.query("ALTER TABLE relations ADD COLUMN IF NOT EXISTS mon_nom_a VARCHAR(120) NULL");
  } catch (e) {
    console.warn("Migration mon_nom_a ignorée (déjà présente ou MySQL trop ancien) :", e.message);
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
  console.log("Base de données prête.");
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
      "SELECT id, type, nom_a, mon_nom_a, jumelee FROM relations WHERE code = ?",
      [String(code).trim().toUpperCase()]
    );
    if (lignes.length === 0) return res.status(404).json({ error: "Code inconnu." });

    const rel = lignes[0];
    if (rel.jumelee) {
      return res.status(409).json({ error: "Cette relation est déjà reliée à un autre téléphone." });
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
   ROUTE — intelligence artificielle (Infomaniak)
   ============================================================ */

app.post("/api/ia", async (req, res) => {
  if (!INFOMANIAK_PRODUCT_ID || !INFOMANIAK_API_KEY) {
    return res.status(500).json({
      error: "Configuration manquante : INFOMANIAK_PRODUCT_ID ou INFOMANIAK_API_KEY absent des variables d'environnement de Render.",
    });
  }

  try {
    // Le modèle défini sur Render prime sur celui envoyé par l'application.
    const corps = INFOMANIAK_MODEL
      ? { ...req.body, model: INFOMANIAK_MODEL }
      : req.body;

    const reponse = await fetch(
      `https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INFOMANIAK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(corps),
      }
    );

    const donnees = await reponse.json();

    if (!reponse.ok) {
      console.error("Erreur Infomaniak :", donnees);
      return res.status(reponse.status).json(donnees);
    }

    res.json(donnees);
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
  });
