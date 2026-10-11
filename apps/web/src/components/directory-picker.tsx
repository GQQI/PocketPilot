import type { FsListing } from "@pocketpilot/protocol";
import { useEffect, useState } from "react";
import { Button, Modal } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useApp } from "@/lib/store";

export function DirectoryPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, replace, setNotice } = useApp();
  const [listing, setListing] = useState<FsListing | null>(null);
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    void api.listFs(current).then((next) => {
      if (!cancelled) setListing(next);
    }).catch(async (caught) => {
      if (cancelled) return;
      if (current) {
        setCurrent("");
        return;
      }
      setError(caught instanceof ApiError ? caught.message : "path");
    });
    return () => {
      cancelled = true;
    };
  }, [open, current]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("dir.title")}>
      <div data-testid="dir-picker">
        <p className="text-sm text-mute">{listing?.demo ? t("dir.demo") : t("dir.live")}</p>
        <p className="mt-3 break-all text-sm font-medium">{listing?.path || t("home.computer")}</p>
        {error ? <p className="mt-2 text-sm text-coral">{error}</p> : null}
        <div className="mt-3 flex gap-2">
          <Button type="button" size="sm" variant="soft" disabled={listing?.parent == null} onClick={() => setCurrent(listing?.parent ?? "")}>{t("dir.up")}</Button>
          <Button
            type="button"
            size="sm"
            disabled={!listing?.path}
            onClick={() => {
              if (!listing?.path) return;
              void api.saveSettings({ workspacePath: listing.path }).then((next) => {
                replace(next);
                setNotice(t("settings.saved"));
                onOpenChange(false);
              });
            }}
          >
            {t("dir.use")}
          </Button>
        </div>
        <ul className="mt-4 space-y-1">
          {listing && listing.entries.filter((entry) => entry.kind === "dir").length === 0 ? <li className="text-sm text-mute">{t("dir.empty")}</li> : null}
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              {entry.kind === "dir" ? (
                <button type="button" className="w-full rounded-2xl px-3 py-3 text-left text-sm hover:bg-soft" onClick={() => setCurrent(entry.path)}>
                  {entry.name}
                </button>
              ) : (
                <div className="px-3 py-2 text-sm text-mute">{entry.name}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
