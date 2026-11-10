/**
 * Construit les paquets desktop avec electron-builder en reprenant
 * la version du package.json racine (pas de version à maintenir en double).
 *
 * Usage : node scripts/dist.js [--linux|--win|--mac] [autres options electron-builder]
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const { version } = require(path.join(root, "package.json"));
const cli = require.resolve("electron-builder/cli.js");

const args = [cli, "--publish", "never", `-c.extraMetadata.version=${version}`, ...process.argv.slice(2)];
console.log(`[desktop] electron-builder ${args.slice(1).join(" ")}`);

const res = spawnSync(process.execPath, args, {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit",
});
process.exit(res.status ?? 1);
