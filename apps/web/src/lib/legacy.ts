/** One-time move of localStorage keys from the former product name (mobileagent.*) to pocketpilot.*. */
export function migrateLegacyStorage(): void {
  try {
    for (const name of ["bridge", "token", "rtc"]) {
      const old = "mobileagent." + name;
      const value = localStorage.getItem(old);
      if (value === null) continue;
      if (localStorage.getItem("pocketpilot." + name) === null) localStorage.setItem("pocketpilot." + name, value);
      localStorage.removeItem(old);
    }
  } catch {
    /* storage unavailable */
  }
}
