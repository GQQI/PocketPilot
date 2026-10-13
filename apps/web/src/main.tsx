import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

function lockZoom() {
  const blockPinch = (event: Event) => {
    if (event instanceof TouchEvent && event.touches.length > 1) event.preventDefault();
  };
  document.addEventListener("touchmove", blockPinch, { passive: false });
  for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(name, (event) => event.preventDefault());
  }
  let lastTouch = 0;
  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouch < 300) event.preventDefault();
    lastTouch = now;
  }, { passive: false });
}
lockZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
