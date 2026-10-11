// Builds the PocketPilot Android APK: web build -> Capacitor sync -> Gradle.
//   node scripts/build-android.mjs [debug|release]
// Toolchain (JDK 17 + Android SDK) is taken from JAVA_HOME / ANDROID_HOME, or from the per-user defaults below.
// Nothing here changes system environment variables.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

const built = path.join(gradleDir, "app/build/outputs/apk", mode, mode === "release" ? "app-release.apk" : "app-debug.apk");
const unsigned = path.join(gradleDir, "app/build/outputs/apk/release/app-release-unsigned.apk");
const source = existsSync(built) ? built : unsigned;
if (!existsSync(source)) {
  console.error("APK not found: " + built);
  process.exit(1);
}
const outDir = path.join(root, "dist-android");
mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, mode === "release" ? "PocketPilot-release.apk" : "PocketPilot-debug.apk");
copyFileSync(source, target);
console.log(`APK: ${target}`);

