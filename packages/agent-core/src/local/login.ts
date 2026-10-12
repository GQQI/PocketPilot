import type { AgentAuth, KeySource } from "@pocketpilot/protocol";

/**
 * Login wins over a saved API key.
 * `useKey` is true only when the CLI is not signed in and the user actually stored a key.
 */
export interface LoginInput {
  /** The CLI or SDK exists on this PC. */
  present: boolean;
  loggedIn: boolean;
  keySource: KeySource;
  /** Empty when this platform has no CLI login. */
  loginCommand: string;
  keyName: string;
  locale: "zh" | "en";
  loginDetail?: string;
  /** Shown when the platform has no CLI login and the key is the real path. */
  keyOnlyReason?: string;
  /** Shown when nothing is installed and no key is saved. */
  absentNote?: string;
  /** Shown when the CLI exists, nobody is signed in, and no key is saved. */
  loggedOutNote?: string;
  /**
   * `unknown` keeps the platform runnable so a CLI we cannot probe can still be tried,
   * without injecting a key. `missing` means it cannot chat until the user signs in or saves a key.
   */
  whenNeither?: "missing" | "unknown";
}

export interface LoginDecision {
  auth: AgentAuth;
  /** Pass the saved key into the child. Never true while `loggedIn` is true. */
  useKey: boolean;
}

export function decideLogin(input: LoginInput): LoginDecision {
  const zh = input.locale !== "en";
  const loginCommand = input.loginCommand;
  if (input.loggedIn && input.present) {
    const where = input.loginDetail ? (zh ? `（${input.loginDetail}）` : ` (${input.loginDetail})`) : "";
    return {
      useKey: false,
      auth: {
        state: "ok",
        source: "login",
        loginCommand,
        note: zh
          ? `已使用本机命令行登录${where}。保存的密钥不会传给子进程。`
          : `Using the CLI login on this PC${where}. A saved key is not passed to the process.`,
      },
    };
  }
  if (input.keySource !== "none" && (input.present || input.keyOnlyReason || !loginCommand)) {
    const backup = input.keyOnlyReason
      || (zh
        ? `未登录，使用备用密钥 ${input.keyName}。在电脑上运行 ${loginCommand} 后会改用登录态，并不再注入该密钥。`
        : `Not signed in, so the optional backup key ${input.keyName} is used. After \`${loginCommand}\` the login is used and the key is not injected.`);
    return {
      useKey: true,
      auth: { state: "ok", source: input.keySource, loginCommand, note: backup },
    };
  }
  if (!input.present) {
    const saved = input.keySource !== "none";
    return {
      useKey: false,
      auth: {
        state: "missing",
        source: saved ? input.keySource : "none",
        loginCommand,
        note: saved
          ? (zh
            ? `命令行还没装好。密钥已保存，但是备用：装好后运行 ${loginCommand || "它的登录命令"}，已登录就不会再用这把密钥。`
            : `The CLI is not installed. A key is saved as a backup; after ${loginCommand || "you sign in"} a login is used instead.`)
          : (input.absentNote
            || input.keyOnlyReason
            || (zh
              ? (loginCommand ? `未安装命令行。装好后运行 ${loginCommand}。密钥只是备用。` : "未安装，也没有密钥。")
              : (loginCommand ? `CLI is not installed. After installing, run ${loginCommand}. A key is only a backup.` : "Not installed and no key."))),
      },
    };
  }
  if (input.whenNeither === "unknown") {
    return {
      useKey: false,
      auth: {
        state: "unknown",
        source: "cli",
        loginCommand,
        note: input.loggedOutNote
          || (zh ? `没能确认登录状态。请在电脑上运行 ${loginCommand}。未确认已登录时不会注入密钥。` : `Login could not be confirmed. Run ${loginCommand} on this PC. A key is not injected unless login is confirmed absent.`),
      },
    };
  }
  return {
    useKey: false,
    auth: {
      state: "missing",
      source: "none",
      loginCommand,
      note: input.loggedOutNote
        || (zh ? `未登录，也没有备用密钥。请在电脑上运行 ${loginCommand}。` : `Not signed in and no backup key. On this PC run ${loginCommand}.`),
    },
  };
}

/** Copy of the child environment. When `useKey` is false, platform key variables are removed so they cannot override a CLI login. */
export function childEnv(env: NodeJS.ProcessEnv, envKeys: readonly string[], useKey: boolean): NodeJS.ProcessEnv {
  if (useKey) return { ...env };
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of envKeys) delete out[key];
  return out;
}

/** Classify a CLI's own status output. Never treats a missing or unknown command as logged in. */
export function interpretCliLogin(text: string, code: number): "in" | "out" | "unknown" {
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  if (/unknown command|unrecognized|not a valid command|no such command|unexpected argument/i.test(plain)) return "unknown";
  if (/not logged in|not signed in|not authenticated|please (log|sign) in|login required/i.test(plain)) return "out";
  if (/(logged in|signed in|authenticated)/i.test(plain)) return "in";
  if (code === 0 && /@/.test(plain) && /login|account|user/i.test(plain)) return "in";
  return "unknown";
}
