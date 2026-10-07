import { useApp } from "@/lib/store";

export function RichText({ text }: { text: string }) {
  const parts = text.split("```");
  return (
    <div className="space-y-1 text-sm leading-6">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const splitAt = part.indexOf("\n");
          const language = splitAt === -1 ? "" : part.slice(0, splitAt).trim();
          const code = splitAt === -1 ? part : part.slice(splitAt + 1);
          return <CodeBlock key={index} language={language} code={code.replace(/\n$/, "")} />;
        }
        if (!part.trim()) return null;
        return <Inline key={index} text={part} />;
      })}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const bits = text.split(/(`[^`]+`)/g);
  return (
    <p className="whitespace-pre-wrap">
      {bits.map((bit, index) =>
        bit.startsWith("`") && bit.endsWith("`") && bit.length > 2 ? (
          <code key={index} className="inline-code">{bit.slice(1, -1)}</code>
        ) : (
          <span key={index}>{bit}</span>
        ),
      )}
    </p>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { setNotice, t } = useApp();
  return (
    <div className="code-block">
      <div className="mb-2 flex items-center justify-between text-[11px] text-mute">
        <span>{language || "code"}</span>
        <button
          type="button"
          className="text-lime"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => setNotice(t("common.copied")));
          }}
        >
          {t("common.copy")}
        </button>
      </div>
      <pre className="whitespace-pre">{code}</pre>
    </div>
  );
}
