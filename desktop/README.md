# Cartes IGN — version desktop

Version desktop (Windows, macOS, Linux) de Cartes IGN, basée sur [Electron](https://www.electronjs.org/).

Elle embarque **la même build web** que les applis mobiles (`npm run build` → `www/`), sans modification du code de `src/` : Capacitor y tourne en mode `web` et utilise ses implémentations navigateur (localStorage pour les préférences, IndexedDB pour les cartes hors ligne, `navigator.geolocation`, etc.). Tout le code propre au desktop est isolé dans ce dossier, pour que la branche reste facile à rebaser sur `main`.

## Lancer en développement

Depuis la racine du dépôt :

```sh
npm ci                  # dépendances de l'appli
npm run desktop:install # dépendances desktop (Electron, electron-builder)
npm run desktop         # build:dev + lancement de la fenêtre desktop
```

Pour itérer sans tout reconstruire : `npm run build:dev` à la racine, puis `npm --prefix desktop start`.
Les outils de développement Chromium sont dans le menu **Affichage → Outils de développement** (le menu apparaît avec la touche Alt sous Windows/Linux).

## Construire les paquets

```sh
npm run desktop:dist                 # paquets pour l'OS courant
cd desktop && npm run dist:linux     # AppImage + .deb
cd desktop && npm run dist:win       # installeur NSIS + zip portable (installeur : sous Windows ou avec wine)
cd desktop && npm run dist:mac       # .dmg + zip (sous macOS uniquement)
```

Les paquets sont produits dans `desktop/dist/`, avec la version du `package.json` racine.
Le workflow GitHub Actions `.github/workflows/desktop-build.yml` construit les trois OS (déclenchement manuel, tag `v*` ou `desktop-*`, ou PR touchant `desktop/`).

Les paquets ne sont **pas signés** : SmartScreen (Windows) et Gatekeeper (macOS) afficheront un avertissement. Sur macOS : clic droit → Ouvrir, ou `xattr -dr com.apple.quarantine "/Applications/Cartes IGN.app"`.

## Fonctionnement

| Fichier | Rôle |
|---|---|
| `main.js` | Processus principal : fenêtre, permissions, liens externes, instance unique |
| `src/app-protocol.js` | Protocole `app://cartes-ign/` qui sert `app/www` (types MIME, requêtes Range) |
| `src/menu.js` | Menu de l'application en français |
| `src/window-state.js` | Mémorise la taille/position de la fenêtre |
| `preload.js` | Expose `window.cartesIgnDesktop` au code web |
| `scripts/prepare-web.js` | Copie `../www` dans `app/www` |
| `scripts/dist.js` | Lance electron-builder avec la version racine |

L'appli est chargée sur `app://cartes-ign/` (origine sécurisée et stable) plutôt qu'en `file://`, parce qu'elle fait des `fetch()` de fichiers locaux, lance le worker MapLibre en module et construit certaines URL à partir de `document.URL`. Les liens externes s'ouvrent dans le navigateur par défaut. Les services sont appelés avec un user-agent suffixé `IGN-app-desktop/<version>`.

### Détecter la version desktop dans le code web

`Capacitor.getPlatform()` renvoie `"web"`. Pour activer un comportement propre au desktop :

```js
if (window.cartesIgnDesktop?.isDesktop) {
  // window.cartesIgnDesktop.platform : "win32" | "darwin" | "linux"
}
```

## Différences avec les applis mobiles

Ce sont celles de la version web, puisque c'est elle qui tourne :

- **Géolocalisation** : macOS utilise les services de localisation du système (autorisation demandée au premier usage) ; Windows utilise la localisation Windows si elle est activée ; **sous Linux, elle ne fonctionne pas** (Chromium y dépend d'un service réseau de Google non configuré dans Electron).
- **Pas d'enregistrement de trace en arrière-plan** ni de notifications de position immersive (plugins natifs uniquement).
- **Partage** : Electron n'a pas d'API de partage ; `preload.js` en fournit une de repli qui copie le contenu (texte + lien) dans le presse-papiers. Les exports GPX/GeoJSON passent par un téléchargement de fichier.
- **Couches temporaires** : comme sur le web, celles marquées `isProdReady: false` sont visibles (filtre `config-utils.js`).
- Les **cartes hors ligne** sont stockées dans IndexedDB (profil Electron), comme dans un navigateur.
