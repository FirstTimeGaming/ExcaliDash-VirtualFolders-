import React, { useCallback, useEffect, useState, useRef } from "react";
import { Layout } from "../components/Layout";
import { ChevronRight, Folder, FolderPlus, Loader2 } from "lucide-react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { useDebounce } from "../hooks/useDebounce";
import { ConfirmModal } from "../components/ConfirmModal";
import { useUpload } from "../context/UploadContext";
import { DragOverlayPortal } from "./dashboard/shared";
import { DashboardToolbar } from "./dashboard/DashboardToolbar";
import { MoveDrawingsModal } from "./dashboard/MoveDrawingsModal";
import {
  DragPreview,
  DrawingsGrid,
  FileDropOverlay,
  ViewerActionToast,
} from "./dashboard/DashboardPanels";
import { useDashboardData } from "./dashboard/useDashboardData";
import { useDashboardCollectionActions } from "./dashboard/useDashboardCollectionActions";
import { useDashboardDrawingActions } from "./dashboard/useDashboardDrawingActions";
import { useDashboardSelection } from "./dashboard/useDashboardSelection";
import { useDashboardSort } from "./dashboard/useDashboardSort";
import { displayFontFamily } from "../utils/displayFont";
import type { MoveSource } from "../api/drawings";
const PAGE_SIZE = 24;
export const Dashboard: React.FC = () => {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedCollectionId = React.useMemo(() => {
    if (location.pathname === "/") return undefined;
    if (location.pathname === "/collections") {
      const id = searchParams.get("id");
      if (id === "unorganized") return null;
      return id || undefined;
    }
    return undefined;
  }, [location.pathname, searchParams]);
  const currentPath = React.useMemo(() => {
    if (selectedCollectionId === undefined || selectedCollectionId === "shared" || selectedCollectionId === "trash") return "/";
    const raw = searchParams.get("path") || "/";
    const segments = raw.replace(/\\/g, "/").split("/").map((segment) => segment.trim()).filter(Boolean);
    return segments.length === 0 ? "/" : `/${segments.join("/").toLowerCase()}/`;
  }, [selectedCollectionId, searchParams]);

  const navigateToPath = (path: string) => {
    if (selectedCollectionId === undefined || selectedCollectionId === "shared" || selectedCollectionId === "trash") return;
    const params = new URLSearchParams();
    params.set("id", selectedCollectionId === null ? "unorganized" : selectedCollectionId);
    if (path !== "/") params.set("path", path);
    navigate(`/collections?${params.toString()}`);
  };

  const setSelectedCollectionId = (id: string | null | undefined) => {
    if (id === undefined) {
      navigate("/");
    } else if (id === null) {
      navigate("/collections?id=unorganized");
    } else {
      navigate(`/collections?id=${id}`);
    }
  };
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkMoveMenu, setShowBulkMoveMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [moveDialog, setMoveDialog] = useState<{ source: MoveSource; collectionId: string | null; path: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const {
    sortConfig,
    sortOptions,
    currentSortOption,
    handleSortFieldChange: setSortField,
    handleSortDirectionToggle,
  } = useDashboardSort();
  const { uploadFiles } = useUpload();
  const resetSelection = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);
  const {
    drawings,
    setDrawings,
    collections,
    setCollections,
    folders,
    setTotalCount,
    isFetchingMore,
    isLoading,
    hasMore,
    refreshData,
    fetchMore,
  } = useDashboardData({
    debouncedSearch,
    selectedCollectionId,
    currentPath,
    sortField: sortConfig.field,
    sortDirection: sortConfig.direction,
    pageSize: PAGE_SIZE,
    onRefreshSuccess: resetSelection,
  });
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) {
          fetchMore();
        }
      },
      { threshold: 0.1 },
    );
    if (loaderRef.current) {
      observer.observe(loaderRef.current);
    }
    return () => observer.disconnect();
  }, [fetchMore, hasMore]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragCounter = useRef(0);
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounter.current += 1;
      if (dragCounter.current === 1) {
        setIsDraggingFile(true);
      }
    }
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      dragCounter.current -= 1;
      if (dragCounter.current === 0) {
        setIsDraggingFile(false);
      }
    }
  }, []);
  const sortedDrawings = drawings;
  const selection = useDashboardSelection({
    drawings: sortedDrawings,
    selectedIds,
    setSelectedIds,
    searchInputRef,
  });
  const handleSortFieldChange = (field: typeof sortConfig.field) => {
    setSortField(field);
    setShowSortMenu(false);
  };
  const actions = useDashboardDrawingActions({
    drawings,
    setDrawings,
    collections,
    selectedCollectionId,
    currentPath,
    selectedIds,
    setSelectedIds,
    setTotalCount,
    uploadFiles,
    refreshData,
    navigate,
  });
  const collectionActions = useDashboardCollectionActions({
    selectedCollectionId,
    setSelectedCollectionId,
    setCollections,
    refreshData,
  });
  const viewTitle = React.useMemo(() => {
    if (selectedCollectionId === undefined) return "All Drawings";
    if (selectedCollectionId === null) return "Unorganized";
    if (selectedCollectionId === "shared") return "Shared with me";
    if (selectedCollectionId === "trash") return "Trash";
    const collection = collections.find((c) => c.id === selectedCollectionId);
    return collection ? collection.name : "Collection";
  }, [selectedCollectionId, collections]);
  const visibleCollections = React.useMemo(
    () => collections.filter((c) => c.id !== "trash"),
    [collections],
  );
  const openMoveDialog = (source: MoveSource, collectionId: string | null) => {
    const currentCollectionId =
      selectedCollectionId === undefined ||
      selectedCollectionId === "shared" ||
      selectedCollectionId === "trash"
        ? null
        : selectedCollectionId;
    setShowBulkMoveMenu(false);
    setMoveDialog({
      source,
      collectionId,
      path: collectionId === currentCollectionId ? currentPath : "/",
    });
  };
  return (
    <Layout
      collections={visibleCollections}
      selectedCollectionId={selectedCollectionId}
      onSelectCollection={setSelectedCollectionId}
      onCreateCollection={collectionActions.handleCreateCollection}
      onEditCollection={collectionActions.handleEditCollection}
      onDeleteCollection={collectionActions.handleDeleteCollection}
      onDrop={actions.isSharedView ? undefined : actions.handleDrop}
    >
      {" "}
      <DragPreview drawings={actions.dragPreviewDrawings} />{" "}
      {selection.isDragSelecting && selection.selectionBounds && (
        <DragOverlayPortal>
          {" "}
          <div
            className="fixed z-50 pointer-events-none border-2 border-black dark:border-neutral-500 bg-neutral-500/20 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]"
            style={{
              left: selection.selectionBounds.left,
              top: selection.selectionBounds.top,
              width: selection.selectionBounds.width,
              height: selection.selectionBounds.height,
            }}
          />{" "}
        </DragOverlayPortal>
      )}{" "}
      <h1
        className="text-3xl sm:text-5xl mb-6 sm:mb-8 text-slate-900 dark:text-white pl-1"
        style={{ fontFamily: displayFontFamily }}
      >
        {" "}
        {viewTitle}{" "}
      </h1>{" "}
      {selectedCollectionId !== undefined &&
        selectedCollectionId !== "shared" &&
        selectedCollectionId !== "trash" && (
          <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
            <button
              className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
              onClick={() => navigateToPath("/")}
            >
              {viewTitle}
            </button>
            {currentPath
              .split("/")
              .filter(Boolean)
              .map((segment, index, all) => {
                const path = `/${all.slice(0, index + 1).join("/")}/`;
                return (
                  <React.Fragment key={path}>
                    <ChevronRight size={15} className="text-slate-400" />
                    <button
                      className="font-semibold text-slate-700 hover:underline dark:text-slate-300"
                      onClick={() => navigateToPath(path)}
                    >
                      {segment}
                    </button>
                  </React.Fragment>
                );
              })}
            <button
              className="ui-button-secondary ml-auto h-9 px-3"
              onClick={() => {
                const name = window.prompt("Folder name");
                if (!name?.trim()) return;
                const segment = name.trim().replace(/[\\/]+/g, "-").toLowerCase();
                if (!segment || segment === "." || segment === "..") return;
                navigateToPath(`${currentPath}${segment}/`);
              }}
            >
              <FolderPlus size={16} /> New Folder
            </button>
          </div>
        )}{" "}
      <ViewerActionToast message={actions.viewerActionError} />{" "}
      <DashboardToolbar
        search={search}
        searchInputRef={searchInputRef}
        sortConfig={sortConfig}
        sortOptions={sortOptions}
        currentSortOption={currentSortOption}
        showSortMenu={showSortMenu}
        sortedDrawingsCount={sortedDrawings.length}
        allSelected={selection.allSelected}
        hasSelection={selection.hasSelection}
        isTrashView={actions.isTrashView}
        isSharedView={actions.isSharedView}
        isSharedCollection={actions.isSharedCollection}
        currentCollection={actions.currentCollection}
        showBulkMoveMenu={showBulkMoveMenu}
        selectedCount={selectedIds.size}
        collections={collections}
        onSearchChange={setSearch}
        onShowSortMenuChange={setShowSortMenu}
        onSortFieldChange={handleSortFieldChange}
        onSortDirectionToggle={handleSortDirectionToggle}
        onSelectAll={selection.handleSelectAll}
        onBulkDeleteClick={actions.handleBulkDeleteClick}
        onBulkDuplicate={actions.handleBulkDuplicate}
        onShowBulkMoveMenuChange={setShowBulkMoveMenu}
        onBulkMove={(collectionId) => openMoveDialog({ type: "drawings", drawingIds: Array.from(selectedIds) }, collectionId)}
        onImportDrawings={actions.handleImportDrawings}
        onCreateDrawing={actions.handleCreateDrawing}
        onViewerActionError={actions.handleViewerActionError}
      />{" "}
      <div
        className="min-h-full select-none relative"
        onMouseDown={selection.handleMouseDown}
        ref={containerRef}
        onDragOver={(e) => {
          e.preventDefault();
          if (!isDraggingFile && e.dataTransfer.types.includes("Files")) {
            setIsDraggingFile(true);
          }
        }}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={(e) => {
          setIsDraggingFile(false);
          dragCounter.current = 0;
          const target =
            selectedCollectionId === undefined ? null : selectedCollectionId;
          if (actions.isSharedView) return;
          actions.handleDrop(e, target);
        }}
      >
        {" "}
        {isDraggingFile && <FileDropOverlay viewTitle={viewTitle} />}{" "}
        {folders.length > 0 && (
          <div className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                onClick={() => navigateToPath(folder.path)}
                className="group flex min-h-24 items-center gap-4 rounded-2xl border-2 border-slate-800 bg-white p-4 text-left shadow-[1.5px_1.5px_0px_0px_rgba(30,41,59,0.9)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0px_0px_rgba(30,41,59,0.9)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[1.5px_1.5px_0px_0px_rgba(255,255,255,0.15)] dark:hover:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.18)]"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-slate-800 bg-slate-50 dark:border-neutral-700 dark:bg-neutral-800">
                  <Folder size={24} className="text-indigo-600 dark:text-indigo-400" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-bold text-slate-800 dark:text-neutral-100">
                    {folder.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-400 dark:text-neutral-500">
                    {folder.path}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}{" "}
        {(sortedDrawings.length > 0 || folders.length === 0) && (
        <DrawingsGrid
          drawings={sortedDrawings}
          collections={collections}
          selectedIds={selectedIds}
          search={search}
          isLoading={isLoading}
          isDraggingFile={isDraggingFile}
          isTrashView={actions.isTrashView}
          isSharedView={actions.isSharedView}
          isSharedCollection={actions.isSharedCollection}
          currentCollection={actions.currentCollection}
          onClearSearch={() => setSearch("")}
          onToggleSelection={selection.handleToggleSelection}
          onRename={actions.handleRenameDrawing}
          onDelete={actions.handleDeleteDrawing}
          onHide={actions.handleHideSharedDrawing}
          onDuplicate={actions.handleDuplicateDrawing}
          onMoveToCollection={(id, collectionId) => openMoveDialog({ type: "drawings", drawingIds: [id] }, collectionId)}
          onOpenDrawing={(id) => navigate(`/editor/${id}`)}
          onMouseDown={actions.handleCardMouseDown}
          onDragStart={actions.handleCardDragStart}
          onPreviewGenerated={actions.handlePreviewGenerated}
        />
        )}{" "}
        <div
          ref={loaderRef}
          className="py-8 flex justify-center items-center h-20"
        >
          {" "}
          {isFetchingMore && (
            <div className="flex items-center gap-2 text-indigo-600 font-bold animate-in fade-in slide-in-from-bottom-2">
              {" "}
              <Loader2 size={24} className="animate-spin" />{" "}
              <span>Loading more...</span>{" "}
            </div>
          )}{" "}
        </div>{" "}
      </div>{" "}
      <MoveDrawingsModal
        isOpen={!!moveDialog}
        source={moveDialog?.source ?? { type: "drawings", drawingIds: [] }}
        collections={collections}
        initialCollectionId={moveDialog?.collectionId ?? null}
        initialPath={moveDialog?.path ?? "/"}
        onClose={() => setMoveDialog(null)}
        onComplete={() => {
          setSelectedIds(new Set());
          refreshData();
        }}
      />
      <ConfirmModal
        isOpen={!!actions.drawingToDelete}
        title="Delete Drawing"
        message="Are you sure you want to permanently delete this drawing? This action cannot be undone."
        confirmText="Delete Permanently"
        onConfirm={() =>
          actions.drawingToDelete &&
          actions.executePermanentDelete(actions.drawingToDelete)
        }
        onCancel={() => actions.setDrawingToDelete(null)}
      />{" "}
      <ConfirmModal
        isOpen={actions.showBulkDeleteConfirm}
        title="Delete Selected Drawings"
        message={`Are you sure you want to permanently delete ${selectedIds.size} drawings? This action cannot be undone.`}
        confirmText={`Delete ${selectedIds.size} Drawings`}
        onConfirm={actions.executeBulkPermanentDelete}
        onCancel={() => actions.setShowBulkDeleteConfirm(false)}
      />{" "}
      <ConfirmModal
        isOpen={actions.showImportError.isOpen}
        title="Import Failed"
        message={actions.showImportError.message}
        confirmText="OK"
        showCancel={false}
        isDangerous={false}
        onConfirm={() =>
          actions.setShowImportError({ isOpen: false, message: "" })
        }
        onCancel={() =>
          actions.setShowImportError({ isOpen: false, message: "" })
        }
      />{" "}
    </Layout>
  );
};
