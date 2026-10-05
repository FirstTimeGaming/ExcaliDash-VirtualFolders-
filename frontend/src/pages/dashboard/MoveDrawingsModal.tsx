import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, Loader2, X } from "lucide-react";
import * as api from "../../api";
import type {
  MoveDestination,
  MovePlan,
  MoveResolution,
  MoveSource,
  VirtualFolderSummary,
} from "../../api";
import type { Collection } from "../../types";

type Props = {
  isOpen: boolean;
  source: MoveSource;
  collections: Collection[];
  initialCollectionId: string | null;
  initialPath: string;
  onClose: () => void;
  onComplete: () => void;
};

export const MoveDrawingsModal: React.FC<Props> = ({
  isOpen,
  source,
  collections,
  initialCollectionId,
  initialPath,
  onClose,
  onComplete,
}) => {
  const [collectionId, setCollectionId] = useState<string | null>(initialCollectionId);
  const [path, setPath] = useState(initialPath);
  const [folders, setFolders] = useState<VirtualFolderSummary[]>([]);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, MoveResolution>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCollectionId(initialCollectionId);
    setPath(initialPath);
    setPlan(null);
    setResolutions({});
    setError(null);
  }, [isOpen, initialCollectionId, initialPath]);

  useEffect(() => {
    if (!isOpen || plan) return;
    let cancelled = false;
    api
      .getDrawings(undefined, collectionId, { path, limit: 1, offset: 0 })
      .then((result) => {
        if (!cancelled) setFolders(result.folders ?? []);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, collectionId, path, plan]);

  const destination: MoveDestination = useMemo(
    () => ({ collectionId, path }),
    [collectionId, path],
  );

  if (!isOpen) return null;

  const runPlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.planDrawingMove(source, destination);
      if (!next.hasCollisions) {
        await api.commitDrawingMove(source, destination);
        onComplete();
        onClose();
        return;
      }
      const defaults: Record<string, MoveResolution> = {};
      for (const item of next.items) {
        defaults[item.drawingId] = item.collision
          ? { action: "skip" }
          : { action: "move" };
      }
      setResolutions(defaults);
      setPlan(next);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? "Unable to plan move");
    } finally {
      setBusy(false);
    }
  };

  const applyAll = (action: "replace" | "skip" | "rename") => {
    if (!plan) return;
    const next = { ...resolutions };
    for (const item of plan.items) {
      if (!item.collision) continue;
      next[item.drawingId] =
        action === "rename"
          ? { action: "rename", name: item.suggestedName ?? `${item.name} (2)` }
          : { action };
    }
    setResolutions(next);
  };

  const commit = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      // Re-run the dry-run immediately before the mutation so the user is not
      // committing a stale collision plan.
      const refreshed = await api.planDrawingMove(source, destination);
      if (refreshed.items.length !== plan.items.length) {
        setPlan(refreshed);
        setError("The destination changed. Review the refreshed move plan.");
        return;
      }
      await api.commitDrawingMove(source, destination, resolutions);
      onComplete();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? "Move failed");
    } finally {
      setBusy(false);
    }
  };

  const segments = path.split("/").filter(Boolean);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-2xl border-2 border-black bg-white p-5 shadow-[6px_6px_0_0_rgba(0,0,0,1)] dark:border-neutral-600 dark:bg-neutral-900">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white">
            {plan ? "Resolve move conflicts" : "Move drawings"}
          </h2>
          <button className="ui-icon-button" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </div>

        {!plan ? (
          <>
            <label className="mb-1 block text-xs font-bold uppercase text-slate-500">
              Collection
            </label>
            <select
              className="mb-4 w-full rounded-xl border-2 border-black bg-white px-3 py-2 dark:border-neutral-600 dark:bg-neutral-800"
              value={collectionId ?? ""}
              onChange={(event) => {
                setCollectionId(event.target.value || null);
                setPath("/");
              }}
            >
              <option value="">Unorganized</option>
              {collections
                .filter((collection) => collection.id !== "trash" && collection.isOwner !== false)
                .map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
            </select>

            <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
              <button className="font-bold text-indigo-600" onClick={() => setPath("/")}>
                Root
              </button>
              {segments.map((segment, index) => {
                const target = `/${segments.slice(0, index + 1).join("/")}/`;
                return (
                  <React.Fragment key={target}>
                    <ChevronRight size={14} />
                    <button className="hover:underline" onClick={() => setPath(target)}>
                      {segment}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            <div className="mb-5 min-h-24 rounded-xl border-2 border-dashed border-slate-200 p-2 dark:border-neutral-700">
              {folders.length === 0 ? (
                <p className="p-3 text-sm text-slate-400">No child folders. You can move here.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {folders.map((folder) => (
                    <button
                      key={folder.path}
                      onClick={() => setPath(folder.path)}
                      className="flex items-center gap-2 rounded-lg p-2 text-left hover:bg-slate-100 dark:hover:bg-neutral-800"
                    >
                      <Folder size={18} className="text-indigo-500" />
                      <span className="truncate font-semibold">{folder.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button className="ui-button-primary" onClick={runPlan} disabled={busy}>
                {busy && <Loader2 size={16} className="animate-spin" />}
                Move here
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <button className="ui-button-secondary" onClick={() => applyAll("replace")}>Replace All</button>
              <button className="ui-button-secondary" onClick={() => applyAll("rename")}>Rename All</button>
              <button className="ui-button-secondary" onClick={() => applyAll("skip")}>Skip All</button>
            </div>
            <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
              {plan.items.map((item) => (
                <div key={item.drawingId} className="rounded-xl border border-slate-200 p-3 dark:border-neutral-700">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{item.name}</div>
                      <div className="truncate text-xs text-slate-500">{item.destination.path}</div>
                    </div>
                    {!item.collision ? (
                      <span className="text-xs font-bold text-emerald-600">Ready</span>
                    ) : (
                      <select
                        className="rounded-lg border px-2 py-1 text-sm dark:bg-neutral-800"
                        value={resolutions[item.drawingId]?.action ?? "skip"}
                        onChange={(event) => {
                          const action = event.target.value as "replace" | "skip" | "rename";
                          setResolutions((current) => ({
                            ...current,
                            [item.drawingId]:
                              action === "rename"
                                ? { action: "rename", name: item.suggestedName ?? `${item.name} (2)` }
                                : { action },
                          }));
                        }}
                      >
                        <option value="replace">Replace</option>
                        <option value="rename">Rename</option>
                        <option value="skip">Skip</option>
                      </select>
                    )}
                  </div>
                  {item.collision && resolutions[item.drawingId]?.action === "rename" && (
                    <input
                      className="w-full rounded-lg border px-2 py-1.5 dark:bg-neutral-800"
                      value={(resolutions[item.drawingId] as { action: "rename"; name: string }).name}
                      onChange={(event) =>
                        setResolutions((current) => ({
                          ...current,
                          [item.drawingId]: { action: "rename", name: event.target.value },
                        }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
            {error && <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p>}
            <div className="mt-4 flex justify-between">
              <button className="ui-button-secondary" onClick={() => setPlan(null)} disabled={busy}>
                Back
              </button>
              <button className="ui-button-primary" onClick={commit} disabled={busy}>
                {busy && <Loader2 size={16} className="animate-spin" />}
                Confirm move
              </button>
            </div>
          </>
        )}
        {!plan && error && <p className="mt-3 text-sm font-semibold text-rose-600">{error}</p>}
      </div>
    </div>
  );
};
