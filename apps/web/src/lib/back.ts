import { backAction } from "@mobileagent/protocol";

const closers: Array<() => void> = [];

export function registerBackCloser(close: () => void): () => void {
  closers.push(close);
  return () => {
    const index = closers.lastIndexOf(close);
    if (index >= 0) closers.splice(index, 1);
  };
}

export function runBackNavigation(pathname: string, goHome: () => void, exit: () => void): void {
  const closer = closers.at(-1);
  if (closer) {
    closer();
    return;
  }
  const action = backAction(pathname);
  if (action.type === "exit") exit();
  else goHome();
}

interface CapacitorApp {
  addListener: (
    name: string,
    callback: (event: { canGoBack?: boolean }) => void,
  ) => Promise<{ remove: () => void }> | { remove: () => void };
  exitApp?: () => void;
}

function capacitorApp(): CapacitorApp | undefined {
  const bridge = (window as Window & { Capacitor?: { Plugins?: { App?: CapacitorApp } } }).Capacitor;
  return bridge?.Plugins?.App;
}

/** System back stays inside the app until home. Capacitor's default exits the activity. */
export function installHardwareBack(onBack: () => void): () => void {
  const app = capacitorApp();
  let removeListener: (() => void) | undefined;
  let disposed = false;
  if (app?.addListener) {
    void Promise.resolve(app.addListener("backButton", () => onBack())).then((handle) => {
      if (disposed) handle.remove();
      else removeListener = () => handle.remove();
    });
  }
  const onCordova = (event: Event) => {
    event.preventDefault();
    onBack();
  };
  document.addEventListener("backbutton", onCordova);
  return () => {
    disposed = true;
    removeListener?.();
    document.removeEventListener("backbutton", onCordova);
  };
}

export function exitApp(): void {
  capacitorApp()?.exitApp?.();
}
