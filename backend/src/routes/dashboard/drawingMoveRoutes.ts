import express from "express";
import { Prisma } from "../../generated/client";
import { getDrawingAccess, isOwnerAccess } from "../../authz/sharing";
import { normalizeVirtualPath, VirtualPathError } from "../../utils/virtualFolders";
import { getUserTrashCollectionId } from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";

type MoveSource =
  | { type: "drawings"; drawingIds: string[] }
  | { type: "folder"; collectionId: string | null; path: string };

type MoveDestination = { collectionId: string | null; path: string };
type Resolution =
  | { action: "move" | "replace" | "skip" }
  | { action: "rename"; name: string };

type MoveRequest = {
  source: MoveSource;
  destination: MoveDestination;
  resolutions?: Record<string, Resolution>;
};

type Candidate = {
  id: string;
  name: string;
  collectionId: string | null;
  path: string;
  destinationPath: string;
};

const collisionKey = (collectionId: string | null, path: string, name: string) =>
  `${collectionId ?? "<unorganized>"}\0${path}\0${name}`;

const suggestRename = (name: string, occupied: Set<string>, keyFor: (name: string) => string) => {
  let suffix = 2;
  let candidate = `${name} (${suffix})`;
  while (occupied.has(keyFor(candidate))) {
    suffix += 1;
    candidate = `${name} (${suffix})`;
  }
  return candidate;
};

export const registerDrawingMoveRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    ensureTrashCollection,
    invalidateDrawingsCache,
  } = context;

  const parseRequest = (body: unknown): MoveRequest => {
    if (!body || typeof body !== "object") throw new Error("Move request is required");
    const value = body as Partial<MoveRequest>;
    if (!value.source || !value.destination) throw new Error("Source and destination are required");
    return value as MoveRequest;
  };

  const ensureDestination = async (userId: string, collectionId: string | null) => {
    if (collectionId === null) return;
    const collection = await prisma.collection.findFirst({
      where: { id: collectionId, userId },
      select: { id: true },
    });
    if (collection) return;
    const editable = await prisma.collectionShare.findFirst({
      where: { collectionId, granteeUserId: userId, role: "edit" },
      select: { id: true },
    });
    if (!editable) throw Object.assign(new Error("Collection not found"), { status: 404 });
  };

  const loadCandidates = async (userId: string, source: MoveSource, destination: MoveDestination) => {
    const destinationPath = normalizeVirtualPath(destination.path);
    if (source.type === "drawings") {
      const ids = [...new Set(source.drawingIds)].filter(Boolean);
      if (ids.length === 0) throw Object.assign(new Error("At least one drawing is required"), { status: 400 });
      const rows = await prisma.drawing.findMany({ where: { id: { in: ids } } });
      if (rows.length !== ids.length) throw Object.assign(new Error("Drawing not found"), { status: 404 });
      for (const row of rows) {
        const access = await getDrawingAccess({ prisma, principal: { kind: "user", userId }, drawingId: row.id });
        if (!isOwnerAccess(access)) {
          throw Object.assign(new Error("Only the owner can move drawings"), { status: 403 });
        }
      }
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        collectionId: row.collectionId,
        path: row.path,
        destinationPath,
      })) satisfies Candidate[];
    }

    const sourcePath = normalizeVirtualPath(source.path);
    const sourceSegments = sourcePath.split("/").filter(Boolean);
    const folderName = sourceSegments[sourceSegments.length - 1];
    if (!folderName) {
      throw Object.assign(new Error("Root cannot be moved as a folder"), { status: 400 });
    }
    if (
      source.collectionId === destination.collectionId &&
      destinationPath.startsWith(sourcePath)
    ) {
      throw Object.assign(
        new Error("A folder cannot be moved into itself or one of its descendants"),
        { status: 400 },
      );
    }
    const destinationFolderPath = normalizeVirtualPath(
      `${destinationPath}${folderName}/`,
    );
    const rows = await prisma.drawing.findMany({
      where: {
        userId,
        collectionId: source.collectionId,
        path: { startsWith: sourcePath },
      },
    });
    if (rows.length === 0) throw Object.assign(new Error("Folder not found"), { status: 404 });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      collectionId: row.collectionId,
      path: row.path,
      destinationPath: normalizeVirtualPath(
        `${destinationPath}${row.path.slice(sourcePath.length)}`,
      ),
    })) satisfies Candidate[];
  };

  const buildPlan = async (userId: string, request: MoveRequest) => {
    await ensureDestination(userId, request.destination.collectionId);
    const candidates = await loadCandidates(userId, request.source, request.destination);
    const movingIds = new Set(candidates.map((item) => item.id));
    const destinationCollectionId = request.destination.collectionId;

    const existing = await prisma.drawing.findMany({
      where: {
        collectionId: destinationCollectionId,
        NOT: { id: { in: [...movingIds] } },
      },
      select: { id: true, name: true, path: true },
    });
    const occupied = new Map(existing.map((row) => [
      collisionKey(destinationCollectionId, normalizeVirtualPath(row.path), row.name),
      row,
    ]));
    const reserved = new Set<string>(occupied.keys());

    const items = candidates.map((candidate) => {
      const keyFor = (name: string) =>
        collisionKey(destinationCollectionId, candidate.destinationPath, name);
      const key = keyFor(candidate.name);
      const collision = occupied.get(key);
      const intraBatchCollision = !collision && reserved.has(key);
      const suggestedName =
        collision || intraBatchCollision
          ? suggestRename(candidate.name, reserved, keyFor)
          : null;
      reserved.add(suggestedName ? keyFor(suggestedName) : key);
      return {
        drawingId: candidate.id,
        name: candidate.name,
        source: { collectionId: candidate.collectionId, path: candidate.path },
        destination: {
          collectionId: destinationCollectionId,
          path: candidate.destinationPath,
          name: candidate.name,
        },
        collision: collision
          ? { drawingId: collision.id, name: collision.name }
          : intraBatchCollision
            ? { drawingId: null, name: candidate.name }
            : null,
        suggestedName,
      };
    });

    return { items, hasCollisions: items.some((item) => item.collision !== null) };
  };

  const handlerError = (res: express.Response, error: unknown) => {
    if (error instanceof VirtualPathError) {
      return res.status(400).json({ error: "Invalid drawing path", message: error.message });
    }
    const status = typeof (error as any)?.status === "number" ? (error as any).status : 400;
    return res.status(status).json({ error: (error as Error)?.message ?? "Invalid move request" });
  };

  app.post(
    "/drawings/move-plan",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      try {
        const request = parseRequest(req.body);
        return res.json(await buildPlan(req.user.id, request));
      } catch (error) {
        return handlerError(res, error);
      }
    }),
  );

  app.post(
    "/drawings/move-commit",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      try {
        const request = parseRequest(req.body);
        const plan = await buildPlan(req.user.id, request);
        const resolutions = request.resolutions ?? {};
        if (plan.hasCollisions) {
          const unresolved = plan.items.filter(
            (item) => item.collision && !resolutions[item.drawingId],
          );
          if (unresolved.length > 0) {
            return res.status(409).json({ error: "Move has unresolved collisions", plan });
          }
        }

        const result = await prisma.$transaction(async (tx) => {
          const moved: string[] = [];
          const skipped: string[] = [];
          const trashed: string[] = [];
          const trashId = getUserTrashCollectionId(req.user!.id);

          for (const item of plan.items) {
            const resolution = resolutions[item.drawingId] ?? { action: "move" as const };
            if (resolution.action === "skip") {
              skipped.push(item.drawingId);
              continue;
            }

            let name = item.name;
            if (resolution.action === "rename") {
              name = String(resolution.name ?? "").trim();
              if (!name) throw Object.assign(new Error("Rename resolution requires a name"), { status: 400 });
            }

            const conflict = await tx.drawing.findFirst({
              where: {
                id: { not: item.drawingId },
                collectionId: item.destination.collectionId,
                path: item.destination.path,
                name,
              },
              select: { id: true, userId: true },
            });

            if (conflict) {
              if (resolution.action !== "replace") {
                throw Object.assign(new Error(`Destination collision for ${name}`), { status: 409 });
              }
              if (conflict.userId !== req.user!.id) {
                throw Object.assign(new Error("Only the owner can replace a destination drawing"), { status: 403 });
              }
              await ensureTrashCollection(tx, req.user!.id);
              await tx.drawing.update({
                where: { id: conflict.id },
                data: { collectionId: trashId },
              });
              trashed.push(conflict.id);
            }

            await tx.drawing.update({
              where: { id: item.drawingId },
              data: {
                collectionId: item.destination.collectionId,
                path: item.destination.path,
                name,
              },
            });
            moved.push(item.drawingId);
          }

          return { moved, skipped, trashed };
        });

        invalidateDrawingsCache();
        return res.json({ success: true, ...result });
      } catch (error) {
        return handlerError(res, error);
      }
    }),
  );
};
