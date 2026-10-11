import { BrowserRouter, Route, Routes } from "react-router";
import { useState } from "react";
import { PairLanding } from "@/components/remote-pair";
import { Shell } from "@/components/shell";
import { AppProvider } from "@/lib/store";
import { ChatPage } from "@/pages/chat";
import { ChatFlow, PlatformStep } from "@/pages/pick";
import { HomePage } from "@/pages/home";
import { ProjectPage, ProjectsPage } from "@/pages/projects";
import { SettingsRouter } from "@/pages/settings";

/** `/#pair=<sid>.<secret>` comes from the desktop QR code. The fragment is never sent to any server. */
function readPairHash(): string | null {
  const match = /^#pair=([\w-]+\.[\w-]+)$/.exec(window.location.hash);
  if (!match) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return match[1];
}

export default function App() {
  const [pairPayload] = useState(readPairHash);
  if (pairPayload) {
    return (
      <AppProvider>
        <PairLanding payload={pairPayload} />
      </AppProvider>
    );
  }
  return (
    <BrowserRouter>
      <AppProvider>
        <Shell>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/chat/in/*" element={<ChatFlow />} />
            <Route path="/chat" element={<PlatformStep />} />
            <Route path="/chat/:agent/:sid" element={<ChatPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/view" element={<ProjectPage />} />
            <Route path="/settings/*" element={<SettingsRouter />} />
          </Routes>
        </Shell>
      </AppProvider>
    </BrowserRouter>
  );
}
