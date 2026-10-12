const closers: Array<() => void> = [];
let go: ((to: string) => void) | null = null;

/** Modal / overlay: the next hardware back closes this instead of leaving the page. */
export function registerBackCloser(close: () => void): () => void {
  closers.push(close);
  return () => {
    const at = closers.lastIndexOf(close);
    if (at >= 0) closers.splice(at, 1);
  };
}

export function bindRouter(navigate: (to: string) => void): void {
  go = navigate;
}

/**
 * In-app parent of a route. Home is the only screen that exits the Android activity.
 * Chat goes back to its session list, then the project list, then the platform list, then home.
 */
export function parentRoute(pathname: string): string | "exit" {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "exit";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "chat") {
    if (parts.length === 1) return "/";
    if (parts[1] === "in") {
      if (parts.length <= 3) return "/chat";
      return `/chat/in/${parts[2]}`;
    }
    if (parts.length >= 3) return `/chat/in/${parts[1]}/sessions`;
    return "/chat";
  }
  if (parts[0] === "projects") return parts.length === 1 ? "/" : "/projects";
  if (parts[0] === "settings") {
    if (parts.length === 1) return "/";
    if (parts[1] === "platforms") {
      if (parts.length === 2) return "/settings";
      if (parts.length === 3) return "/settings/platforms";
      return `/settings/platforms/${parts[2]}`;
    }
    if (parts[1] === "about" && parts.length >= 3) return "/settings/about";
    return "/settings";
  }
  return "/";
}

export function hardwareBack(): "nav" | "exit" {
  const closer = closers.at(-1);
  if (closer) {
    closer();
    return "nav";
  }
  const next = parentRoute(window.location.pathname);
  if (next === "exit") return "exit";
  if (go) go(next);
  else window.history.pushState(null, "", next);
  return "nav";
}

/** Android MainActivity calls `window.__pocketpilotBack()`. The DOM `backbutton` event is the same path. */
export function installHardwareBack(): () => void {
  const w = window as Window & { __pocketpilotBack?: () => "nav" | "exit" };
  w.__pocketpilotBack = hardwareBack;
  const onEvent = (event: Event) => {
    event.preventDefault();
    hardwareBack();
  };
  document.addEventListener("backbutton", onEvent);
  return () => {
    document.removeEventListener("backbutton", onEvent);
    if (w.__pocketpilotBack === hardwareBack) delete w.__pocketpilotBack;
  };
}
