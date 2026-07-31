/**
 * Serveur backend de Tamisé — à déployer sur Render.
 *
 * Rôle unique : garder la clé API Infomaniak en sécurité, côté serveur,
 * et relayer les demandes de l'application vers Infomaniak AI Services.
 * Le frontend (le prototype React) n'a jamais accès à cette clé.
 *
 * Le frontend envoie déjà le body exact attendu par Infomaniak
 * ({ model, messages, max_tokens }) — ce serveur n'a donc quasiment rien
 * à transformer, juste à ajouter la clé secrète et relayer.
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

// ⚠️ En production, remplace "*" par l'adresse exacte de ton site Netlify
// (ex. "https://tamise.netlify.app") pour que seule ton app puisse
// utiliser ce serveur.
app.use(cors({ origin: "*" }));

const INFOMANIAK_PRODUCT_ID = process.env.INFOMANIAK_PRODUCT_ID;
const INFOMANIAK_API_KEY = process.env.INFOMANIAK_API_KEY;

// Petite route de vérification, pour confirmer que le serveur tourne
app.get("/", (req, res) => {
  res.json({ statut: "Serveur Tamisé en ligne" });
});

// La route appelée par l'application (voir BACKEND_URL dans le code React)
app.post("/api/ia", async (req, res) => {
  if (!INFOMANIAK_PRODUCT_ID || !INFOMANIAK_API_KEY) {
    return res.status(500).json({
      error: "Configuration manquante : INFOMANIAK_PRODUCT_ID ou INFOMANIAK_API_KEY absent des variables d'environnement de Render.",
    });
  }

  try {
    const reponse = await fetch(
      `https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${INFOMANIAK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur Tamisé démarré sur le port ${PORT}`);
});
