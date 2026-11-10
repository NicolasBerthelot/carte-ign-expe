/**
 * Copie la build web (../www, produite par `npm run build` à la racine)
 * dans desktop/app/www pour qu'Electron la serve et qu'electron-builder l'embarque.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const src = path.join(root, "www");
const dest = path.resolve(__dirname, "..", "app", "www");

if (!fs.existsSync(path.join(src, "index.html")) || !fs.existsSync(path.join(src, "js", "index.bundle.js"))) {
  console.error(
    "\n[desktop] Build web introuvable dans www/.\n" +
    "          Lancez d'abord `npm run build` (ou `npm run build:dev`) à la racine du dépôt,\n" +
    "          ou utilisez directement `npm run desktop` / `npm run desktop:dist` depuis la racine.\n"
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });

// Version de l'appli web, pour l'afficher dans « À propos » et la reporter dans les paquets
const { version } = require(path.join(root, "package.json"));
fs.writeFileSync(path.join(dest, "..", "build-info.json"), JSON.stringify({
  version,
  builtAt: new Date().toISOString(),
}, null, 2));

console.log(`[desktop] Build web ${version} copiée dans ${path.relative(root, dest)}`);
