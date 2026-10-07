import { BrowserRouter, Route, Routes } from "react-router";
import { Shell } from "@/components/shell";
import { AppProvider } from "@/lib/store";
import { ChatIndex, ChatPage } from "@/pages/chat";
import { HomePage } from "@/pages/home";
import { ProjectPage, ProjectsPage } from "@/pages/projects";
import { QueuePage } from "@/pages/queue";
import { SettingsPage } from "@/pages/settings";

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Shell>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/chat" element={<ChatIndex />} />
            <Route path="/chat/:sessionId" element={<ChatPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<ProjectPage />} />
            <Route path="/queue" element={<QueuePage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Shell>
      </AppProvider>
    </BrowserRouter>
  );
}
