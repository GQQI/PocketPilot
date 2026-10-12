import type { MessageBlock, StreamEvent } from "@mobileagent/protocol";

export function chunkText(text: string, size = 18): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.length ? parts : [""];
}

export function buildPlan(providerId: string, prompt: string): StreamEvent[] {
  const focus = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
  const voice = voiceFor(providerId, focus);
  const events: StreamEvent[] = [
    { type: "status", status: "thinking" },
    { type: "thinking", delta: voice.thinking },
    { type: "tool", phase: "start", name: voice.tool, detail: voice.toolDetail },
    { type: "tool", phase: "done", name: voice.tool, detail: voice.toolDetail },
  ];
  for (const delta of chunkText(voice.reply)) events.push({ type: "text", delta });
  events.push({ type: "usage", input: 700 + prompt.length, output: voice.reply.length });
  events.push({ type: "done" });
  return events;
}

export function blocksFromEvents(events: StreamEvent[]): { blocks: MessageBlock[]; tokens?: { input: number; output: number } } {
  let thinking = "";
  let text = "";
  const tools: MessageBlock[] = [];
  let tokens: { input: number; output: number } | undefined;
  for (const event of events) {
    if (event.type === "thinking") thinking += event.delta;
    if (event.type === "text") text += event.delta;
    if (event.type === "tool" && event.phase === "start") {
      tools.push({ type: "tool", name: event.name, detail: event.detail, status: "running" });
    }
    if (event.type === "tool" && event.phase === "done") {
      const index = tools.findLastIndex((block) => block.type === "tool" && block.name === event.name && block.status === "running");
      if (index >= 0) {
        const current = tools[index];
        if (current?.type === "tool") tools[index] = { ...current, detail: event.detail || current.detail, status: "done" };
      } else {
        tools.push({ type: "tool", name: event.name, detail: event.detail, status: "done" });
      }
    }
    if (event.type === "usage") tokens = { input: event.input, output: event.output };
  }
  const blocks: MessageBlock[] = [];
  if (thinking) blocks.push({ type: "thinking", text: thinking });
  blocks.push(...tools);
  if (text) blocks.push({ type: "text", text });
  return { blocks, tokens };
}

function voiceFor(providerId: string, focus: string): { thinking: string; tool: string; toolDetail: string; reply: string } {
  switch (providerId) {
    case "claude-code":
      return {
        thinking: "先把任务拆成文件读取和一处改动，避免顺手改无关模块。",
        tool: "read_file",
        toolDetail: "README.md",
        reply: `围绕「${focus}」看过当前文件。建议只改一处入口，并把失败路径写成可以单独断言的错误。需要的话我可以继续补测试。`,
      };
    case "codex":
      return {
        thinking: "用一次非交互执行完成这轮编辑，不启动交互式审批。",
        tool: "apply_patch",
        toolDetail: "atlas/migrate.py",
        reply: `Codex 这轮按「${focus}」处理。改动保持在一个文件里，没有对仓库执行写操作以外的命令。`,
      };
    case "opencode":
      return {
        thinking: "先读相关文件，再给出可以复查的结论。",
        tool: "read_file",
        toolDetail: "src/screens/Feed.tsx",
        reply: `OpenCode 看过「${focus}」。影响面集中在首屏渲染，导航本身可以不动。`,
      };
    case "gemini":
      return {
        thinking: "这条线路刚才偏慢，先给简短结论。",
        tool: "read_file",
        toolDetail: "README.md",
        reply: `结论先说：${focus}。详细展开可以等下一轮，这一轮只保留可以直接执行的一步。`,
      };
    case "deepseek-harness":
      return {
        thinking: "DeepSeek Harness 的 headless 档案只跑一轮任务，先看工具轨迹再回答。",
        tool: "shell",
        toolDetail: "dsh --profile headless",
        reply: `DeepSeek Harness 用 headless 档案跑完「${focus}」。模型以 dsh 配置档为准。能拆成插件的部分留在工具边界上，不塞进核心循环。`,
      };
    case "grok":
      return {
        thinking: "先把问题收成一句，再给可以直接执行的下一步。",
        tool: "web_search",
        toolDetail: "api.x.ai",
        reply: `Grok 看过「${focus}」。密钥留在电脑上，回复按流式片段回到手机。`,
      };
    case "trae-cn":
      return {
        thinking: "按一次对话归并，不把每一条消息拆成历史行。",
        tool: "read_file",
        toolDetail: "README.md",
        reply: `Trae CN 把「${focus}」收成这一次会话。历史里只保留对话，不按单条消息铺开。`,
      };
    default:
      return {
        thinking: "先定位相关文件，再给一个小补丁。",
        tool: "read_file",
        toolDetail: "src/auth/middleware.ts",
        reply: `Cursor CLI 接手「${focus}」。我把改动限制在当前会话提到的文件里，并留了一个可以排队的后续用例。`,
      };
  }
}

export function delayFor(event: StreamEvent): number {
  if (event.type === "text") return 18;
  if (event.type === "thinking") return 90;
  if (event.type === "tool") return 70;
  return 10;
}
