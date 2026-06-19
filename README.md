# APEX — Mode d'emploi pour mettre l'app en ligne

Suis ces étapes dans l'ordre. Aucune ligne de commande nécessaire.

---

## Étape 1 — Crée un compte GitHub
1. Va sur https://github.com et clique **Sign up**.
2. Crée ton compte (gratuit).

## Étape 2 — Dépose le projet sur GitHub
1. Une fois connecté, clique le bouton **+** en haut à droite → **New repository**.
2. Donne-lui un nom, par exemple `apex`.
3. Laisse-le en **Public** (ou Private si tu préfères), puis **Create repository**.
4. Sur la page qui s'ouvre, clique le lien **« uploading an existing file »**
   (au milieu de la page).
5. **Décompresse le fichier `apex-app.zip`** sur ton ordinateur, puis
   **glisse-dépose TOUT le contenu du dossier** (pas le dossier lui-même,
   mais les fichiers et dossiers à l'intérieur : `src`, `public`,
   `package.json`, `index.html`, etc.) dans la zone de GitHub.
   ⚠️ Ne mets PAS le dossier `node_modules` s'il existe (il est inutile).
6. En bas, clique **Commit changes**.

## Étape 3 — Mets en ligne avec Vercel
1. Va sur https://vercel.com et clique **Sign up** → choisis
   **Continue with GitHub** (connexion avec ton compte GitHub).
2. Clique **Add New…** → **Project**.
3. Trouve ton dépôt `apex` dans la liste et clique **Import**.
4. Ne change rien aux réglages, clique simplement **Deploy**.
5. Attends ~1 minute. Vercel te donne un lien du type
   `https://apex-xxx.vercel.app`. **C'est l'adresse de ton app !**

## Étape 4 — Installe-la sur ton téléphone
1. Ouvre le lien Vercel sur ton téléphone.
   - **iPhone** : dans Safari, bouton Partager → **Ajouter à l'écran d'accueil**.
   - **Android** : dans Chrome, menu ⋮ → **Ajouter à l'écran d'accueil**.
2. L'app apparaît avec son icône, comme une vraie appli.

## Partager
Envoie simplement le lien `https://apex-xxx.vercel.app` à qui tu veux.
Chaque personne a ses propres données (sauvegardées sur son appareil).

---

## Bon à savoir
- Tes données (séances, records, poids) sont stockées **sur ton appareil**,
  dans le navigateur. Elles restent d'une fois sur l'autre.
- Si tu vides les données du navigateur ou changes de téléphone, elles
  partent. Utilise le bouton **Export JSON** (onglet Historique) de temps
  en temps pour les sauvegarder.
- Pour une vraie synchro entre plusieurs appareils, il faudra brancher une
  base de données (le fichier `apex-schema.sql` est prêt pour ça).

## Modifier l'app plus tard
Pour changer quelque chose, édite `src/App.jsx` directement sur GitHub
(clique le fichier → l'icône crayon ✏️ → modifie → Commit).
Vercel redéploie automatiquement à chaque modification.
