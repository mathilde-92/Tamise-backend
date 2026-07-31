/**
 * Serveur backend de Tamisé — à déployer sur Render.
 *
 * Deux rôles :
 *  1. Garder la clé API Infomaniak en sécurité et relayer les demandes d'IA.
 *  2. Stocker les données partagées d'une relation (messages, agenda, dépenses…)
 *     pour que deux téléphones voient la même chose.
 *
 * Base de données : MySQL (service managé Infomaniak, hébergé en Suisse).
 *
 * Variables d'environnement attendues sur Render :
 *   INFOMANIAK_PRODUCT_ID   ton identifiant produit AI Services
 *   INFOMANIAK_API_KEY      ton token API Infomaniak
 *   INFOMANIAK_MODEL        le nom du modèle (ex. mistral24b)
 *   DATABASE_URL            adresse de la base MySQL, sous la forme
 *                           mysql://utilisateur:motdepasse@serveur:port/nom_base
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json({ limit: "10mb" })); // marge pour les photos en base64

// ⚠️ En production, remplace "*" par l'adresse exacte de ton site Netlify
// (ex. "https://tamise.netlify.app") pour que seule ton app puisse
// utiliser ce serveur.
app.use(cors({ origin: "*" }));

const INFOMANIAK_PRODUCT_ID = process.env.INFOMANIAK_PRODUCT_ID;
const INFOMANIAK_API_KEY = process.env.INFOMANIAK_API_KEY;
// Modèle utilisé. Défini ici (côté serveur) plutôt que dans l'application :
// ça permet d'en changer sans avoir à reconstruire tout le site.
const INFOMANIAK_MODEL = process.env.INFOMANIAK_MODEL;

/* ============================================================
   BASE DE DONNÉES (MySQL)
   ============================================================ */

let pool = null;
if (process.env.DATABASE_URL) {
  pool = mysql.createPool({
    uri: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // les bases managées imposent une connexion TLS
    waitForConnections: true,
    connectionLimit: 5,
  });
}

async function initBase() {
  if (!pool) {
    console.warn("DATABASE_URL absent : le partage entre téléphones est désactivé.");
    return;
  }
  // Note : MySQL n'accepte pas "CREATE INDEX IF NOT EXISTS",
  // l'index est donc déclaré directement dans la table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relations (
      id       VARCHAR(36)  NOT NULL PRIMARY KEY,
      code     VARCHAR(12)  NOT NULL UNIQUE,
      type     VARCHAR(32)  NULL,
      nom_a    VARCHAR(120) NULL,
      nom_b    VARCHAR(120) NULL,
      jumelee  TINYINT(1)   NOT NULL DEFAULT 0,
      cree_le  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
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
    const { nom, type } = req.body || {};
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
      "INSERT INTO relations (id, code, type, nom_a) VALUES (?, ?, ?, ?)",
      [id, code, type || null, nom || null]
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
      "SELECT id, type, nom_a, jumelee FROM relations WHERE code = ?",
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
    res.json({ relationId: rel.id, type: rel.type, nomAutre: rel.nom_a });
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
