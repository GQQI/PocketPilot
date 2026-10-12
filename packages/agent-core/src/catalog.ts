import type { BuiltinProviderId, HealthState, ProviderMeta } from "@mobileagent/protocol";

export interface CatalogEntry extends ProviderMeta {
  id: BuiltinProviderId;
  demo: { state: HealthState; latencyMs: number };
}

/**
 * Built-in roster.
 * CloudCLI's open-source provider registry (siteboon/claudecodeui) currently
 * ships claude, codex, cursor, and opencode. The hosted CloudCLI docs also
 * list Gemini CLI. DeepSeek Harness is MobileAgent's additional adapter.
 * VS Code is intentionally not a provider.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: "cursor",
    name: "Cursor CLI",
    vendor: "Cursor",
    cli: "agent",
    defaultModel: "auto",
    models: ["auto", "composer"],
    endpoint: "",
    envKeys: ["CURSOR_API_KEY"],
    docsUrl: "https://cursor.com/docs/cli/overview",
    accent: "#3f6b56",
    monogram: "Cu",
    demo: { state: "healthy", latencyMs: 36 },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    cli: "claude",
    defaultModel: "sonnet",
    models: ["sonnet", "opus", "haiku"],
    endpoint: "",
    envKeys: ["ANTHROPIC_API_KEY"],
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    accent: "#8a5966",
    monogram: "Cl",
    demo: { state: "healthy", latencyMs: 48 },
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    cli: "codex",
    defaultModel: "gpt-5-codex",
    models: ["gpt-5-codex"],
    endpoint: "",
    envKeys: ["OPENAI_API_KEY"],
    docsUrl: "https://developers.openai.com/codex",
    accent: "#4a5d86",
    monogram: "Cx",
    demo: { state: "healthy", latencyMs: 57 },
  },
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "OpenCode",
    cli: "opencode",
    defaultModel: "",
    models: [],
    endpoint: "",
    envKeys: ["OPENCODE_API_KEY"],
    docsUrl: "https://opencode.ai",
    accent: "#3d6a62",
    monogram: "Oc",
    demo: { state: "healthy", latencyMs: 41 },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    cli: "gemini",
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    endpoint: "",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    accent: "#6d5a86",
    monogram: "Ge",
    demo: { state: "degraded", latencyMs: 480 },
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    vendor: "DeepSeek",
    cli: "dsh",
    defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    endpoint: "https://api.deepseek.com",
    envKeys: ["DEEPSEEK_API_KEY"],
    docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
    accent: "#3e5f86",
    monogram: "Ds",
    demo: { state: "healthy", latencyMs: 64 },
  },
  {
    id: "grok",
    name: "Grok",
    vendor: "xAI",
    cli: "grok",
    defaultModel: "grok-4",
    models: ["grok-4", "grok-3"],
    endpoint: "https://api.x.ai/v1",
    envKeys: ["XAI_API_KEY"],
    docsUrl: "https://docs.x.ai",
    accent: "#8d7355",
    monogram: "Gk",
    demo: { state: "healthy", latencyMs: 44 },
  },
  {
    id: "trae-cn",
    name: "Trae CN",
    vendor: "Trae",
    cli: "trae",
    defaultModel: "",
    models: [],
    endpoint: "",
    envKeys: [],
    docsUrl: "https://www.trae.ai",
    accent: "#3d6a4a",
    monogram: "Tr",
    demo: { state: "healthy", latencyMs: 42 },
  },
];

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** Args passed to the CLI in live mode. Model flags are only added when the flag is part of that CLI's public interface. */
export function launchArgs(id: string, model: string, prompt: string): string[] {
  switch (id) {
    case "cursor":
      return model && model !== "auto"
        ? ["-p", "--output-format", "stream-json", "--stream-partial-output", "--model", model, prompt]
        : ["-p", "--output-format", "stream-json", "--stream-partial-output", prompt];
    case "claude-code":
      return model
        ? ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", model, prompt]
        : ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", prompt];
    case "codex":
      return ["exec", "--json", "--skip-git-repo-check", prompt];
    case "opencode":
      return ["run", prompt];
    case "gemini":
      return model ? ["-p", "-m", model, prompt] : ["-p", prompt];
    case "deepseek-harness":
      return ["--profile", "headless", prompt];
    default:
      return [prompt];
  }
}
