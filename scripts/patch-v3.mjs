// one-off: edits to existing files that are not shipped in the sync zip
import { readFileSync, writeFileSync } from "node:fs";
function sub(file, a, b) { const s = readFileSync(file, "utf8"); if (!s.includes(a)) throw new Error(`${file}: ${a.slice(0, 40)}`); writeFileSync(file, s.replace(a, b)); }
sub("scripts/make-icons.mjs", 'import { mkdirSync, writeFileSync } from "node:fs";', 'import { existsSync, mkdirSync, writeFileSync } from "node:fs";');
sub("scripts/make-icons.mjs", "mkdirSync(outDir, { recursive: true });", 'mkdirSync(outDir, { recursive: true });\nif (existsSync(path.join(outDir, "icon-192.png")) && existsSync(path.join(outDir, "icon-512.png"))) {\n  console.log("icons exist (rendered from favicon.svg by scripts/make-web-icons.mjs)");\n  process.exit(0);\n}');
const a = "scripts/make-android-icons.mjs";
sub(a, 'const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;', 'const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;\nconst fgSvg = readFileSync(path.join(root, "apps/web/public/icon-foreground.svg"), "utf8");\nconst fgUri = `data:image/svg+xml;base64,${Buffer.from(fgSvg).toString("base64")}`;');
sub(a, "async function render(size, { round = false, inset = 0 } = {}) {", "async function render(size, { round = false, inset = 0, src = uri } = {}) {");
sub(a, '<img src="${uri}"', '<img src="${src}"');
sub(a, "await render(size, { inset: 0.17 })", "await render(size, { inset: 0.12, src: fgUri })");
sub(a, "#EEF3F8", "#2F6FED");
sub("apps/web/index.html", '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />', '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />\n    <link rel="icon" type="image/svg+xml" href="/icon-dark.svg" media="(prefers-color-scheme: dark)" />');
const m = "apps/android/android/app/src/main/AndroidManifest.xml";
sub(m, '<uses-permission android:name="android.permission.CAMERA" />', '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="android.permission.VIBRATE" />');
console.log("patched");
