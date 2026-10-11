// Builds the PocketPilot Android APK: web build -> Capacitor sync -> Gradle.
//   node scripts/build-android.mjs [debug|release]
// Toolchain (JDK 17 + Android SDK) is taken from JAVA_HOME / ANDROID_HOME, or from the per-user defaults below.
// Nothing here changes system environment variables.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "release" ? "release" : "debug";
const win = process.platform === "win32";
const javaHome = process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, "bin")) && /17/.test(process.env.JAVA_HOME) ? process.env.JAVA_HOME : path.join(homedir(), "jdk-17");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), "android-sdk");
if (!existsSync(javaHome) || !existsSync(sdk)) {
  console.error(`Missing toolchain. Need JDK 17 at ${javaHome} and Android SDK at ${sdk} (see the Android section of the usage guide in docs/).`);
  process.exit(1);
}
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH}` };
const androidDir = path.join(root, "apps/android");
const gradleDir = path.join(androidDir, "android");

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell: win });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "build"], root);
run("npx", ["cap", "sync", "android"], androidDir);
writeFileSync(path.join(gradleDir, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
run(win ? "gradlew.bat" : "./gradlew", [mode === "release" ? "assembleRelease" : "assembleDebug"], gradleDir);

// ---- align + sign (the APK that Gradle emits for release is *unsigned* unless POCKETPILOT_KEYSTORE is set, which Android refuses to install) ----
const btRoot = path.join(sdk, "build-tools");
const bt = readdirSync(btRoot).filter((d) => /^\d/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
if (!bt) { console.error("No Android build-tools in " + btRoot); process.exit(1); }
const zipalign = path.join(btRoot, bt, win ? "zipalign.exe" : "zipalign");
const apksigner = path.join(btRoot, bt, win ? "apksigner.bat" : "apksigner");
const outDir = path.join(root, "dist-android");
mkdirSync(outDir, { recursive: true });
const apkDir = path.join(gradleDir, "app/build/outputs/apk", mode);
const source = [mode === "release" ? "app-release-unsigned.apk" : "app-debug.apk", mode === "release" ? "app-release.apk" : "app-debug-unsigned.apk"].map((n) => path.join(apkDir, n)).find(existsSync);
if (!source) { console.error("APK not found in " + apkDir); process.exit(1); }

// keystore: release = release/keystore (password from the .password.txt next to it, never printed); debug = .tmp/debug.keystore (auto-generated, password "android")
let ks, alias, passFile;
if (mode === "release") {
  ks = process.env.POCKETPILOT_KEYSTORE || path.join(root, "release/keystore/pocketpilot-release.keystore");
  passFile = process.env.POCKETPILOT_KEYSTORE_PASSWORD_FILE || path.join(root, "release/keystore/pocketpilot-release.keystore.password.txt");
  alias = process.env.POCKETPILOT_KEY_ALIAS || "pocketpilot";
  if (!existsSync(ks) || !existsSync(passFile)) { console.error(`Release keystore/password not found (${ks}). Refusing to emit an unsigned APK.`); process.exit(1); }
} else {
  ks = path.join(root, ".tmp/debug.keystore");
  passFile = path.join(root, ".tmp/debug.keystore.password.txt");
  alias = "androiddebugkey";
  if (!existsSync(ks)) {
    mkdirSync(path.dirname(ks), { recursive: true });
    writeFileSync(passFile, "android");
    run(path.join(javaHome, "bin", win ? "keytool.exe" : "keytool"), ["-genkeypair", "-keystore", ks, "-storepass", "android", "-keypass", "android", "-alias", alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=AndroidDebug,O=Android,C=US"], root);
  }
}
// passwords reach apksigner through environment variables only (never on the command line or in logs).
// The password file is either "alias=/storePassword=/keyPassword=" lines or a bare password.
const txt = readFileSync(passFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const props = Object.fromEntries(txt.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const storePass = props.storePassword ?? txt[0];
if (props.alias && mode === "release" && !process.env.POCKETPILOT_KEY_ALIAS) alias = props.alias;
env.PP_KS_PASS = storePass;
env.PP_KEY_PASS = props.keyPassword ?? storePass;
const name = mode === "release" ? "PocketPilot-release.apk" : "PocketPilot-debug.apk";
const aligned = path.join(outDir, name + ".aligned");
const target = path.join(outDir, name);
rmSync(aligned, { force: true });
run(zipalign, ["-p", "-f", "4", source, aligned], root);            // 1) align first ...
run(apksigner, ["sign", "--ks", ks, "--ks-key-alias", alias, "--ks-pass", "env:PP_KS_PASS", "--key-pass", "env:PP_KEY_PASS", // 2) ... then sign (signing after align keeps both valid)
  "--v1-signing-enabled", "true", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true", "--out", target, aligned], root);
rmSync(aligned, { force: true });
rmSync(target + ".idsig", { force: true });
run(zipalign, ["-c", "-p", "4", target], root);
run(apksigner, ["verify", "--verbose", "--print-certs", target], root);
console.log(`APK: ${target}`);
