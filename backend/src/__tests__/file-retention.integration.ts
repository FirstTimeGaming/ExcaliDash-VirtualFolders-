import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import type { Server } from "socket.io";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb } from "./testUtils";
import { encodeSnapshotField } from "../snapshots/snapshotCodec";
import { registerStorageRoutes } from "../routes/storage";
import { collectRetainedDrawingFileIds } from "../routes/storage/retainedFiles";
import { registerDrawingCreateUpdateRoutes } from "../routes/dashboard/drawingCreateUpdateRoutes";
import type { DrawingRouteContext } from "../routes/dashboard/drawingRouteContext";
import { applySceneUpdateTx } from "../routes/dashboard/sceneUpdate";
import { internDrawingFiles } from "../fileProcessing";
import {
  deleteS3Object,
  getS3Config,
  isS3Enabled,
  listS3Objects,
  uploadBuffer,
} from "../s3";

vi.mock("../s3", () => ({
  isS3Enabled: vi.fn(() => false),
  getS3Config: vi.fn(() => null),
  deleteS3Object: vi.fn(async () => {}),
  listS3Objects: vi.fn(async () => []),
  uploadBuffer: vi.fn(async () => "unused"),
  getPublicUrl: vi.fn((key: string) => `https://files.example/${key}`),
  buildS3Key: vi.fn(
    (userId: string, drawingId: string, fileId: string) =>
      `${userId}/${drawingId}/${fileId}.png`,
  ),
  drawingS3Prefix: vi.fn(
    (userId: string, drawingId: string) => `${userId}/${drawingId}/`,
  ),
}));

const parseJsonField = <T>(raw: string | null | undefined, fallback: T): T =>
  raw ? JSON.parse(raw) : fallback;
const asyncHandler =
  <T>(
    handler: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => Promise<T>,
  ): express.RequestHandler =>
  (req, res, next) => {
    void handler(req, res, next).catch(next);
  };

describe("File reference lifetime", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let app: express.Express;
  let auth: express.RequestHandler;

  beforeAll(() => {
    setupTestDb();
    prisma = getTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(isS3Enabled).mockReturnValue(false);
    vi.mocked(getS3Config).mockReturnValue(null);
    vi.mocked(listS3Objects).mockResolvedValue([]);
    await cleanupTestDb(prisma);
    await prisma.drawingFile.deleteMany({});
    await prisma.user.deleteMany({});
    const owner = await prisma.user.create({
      data: {
        email: "retention@test.local",
        passwordHash: "unused",
        name: "Owner",
      },
    });
    ownerId = owner.id;
    auth = (req, _res, next) => {
      req.user = { id: ownerId } as express.Request["user"];
      next();
    };
    app = express();
    app.use(express.json());
    app.use(auth);
  });

  const createDrawing = () =>
    prisma.drawing.create({
      data: {
        userId: ownerId,
        name: "Retention",
        elements: "[]",
        appState: "{}",
        files: "{}",
      },
    });
  const mountStorage = () =>
    registerStorageRoutes(app, {
      prisma,
      requireAuth: auth,
      asyncHandler,
      parseJsonField,
      invalidateDrawingsCache: vi.fn(),
      io: { to: () => ({ emit: vi.fn() }) } as unknown as Server,
    });

  const mountDrawingUpdates = (
    internFiles: DrawingRouteContext["internDrawingFiles"],
  ) =>
    registerDrawingCreateUpdateRoutes(app, {
      prisma,
      requireAuth: auth,
      optionalAuth: auth,
      asyncHandler,
      parseJsonField,
      drawingUpdateSchema: z.object({
        elements: z.array(z.any()),
        files: z.record(z.string(), z.any()),
        version: z.number().optional(),
      }),
      getRequestPrincipal: async () => ({ kind: "user", userId: ownerId }),
      respondWithAuthErrorIfPresent: () => false,
      invalidateDrawingsCache: vi.fn(),
      config: { nodeEnv: "test" },
      internDrawingFiles: internFiles,
    } as unknown as DrawingRouteContext);

  it.each(["trim", "orphans"])(
    "rejects an unversioned save when %s removes its interned image before commit",
    async (operation) => {
      const drawing = await createDrawing();
      mountStorage();
      mountDrawingUpdates(async (files, userId, drawingId) => {
        const processed = await internDrawingFiles(
          files,
          userId,
          drawingId,
          prisma,
        );
        const cleaned =
          operation === "trim"
            ? await request(app)
                .post(`/drawings/${drawingId}/trim`)
                .send({ confirmName: drawing.name })
            : await request(app)
                .delete(`/drawings/${drawingId}/files/orphans`)
                .send({ confirmName: drawing.name, fileIds: ["image"] });
        expect(cleaned.status).toBe(200);
        return processed;
      });
      const res = await request(app)
        .put(`/drawings/${drawing.id}`)
        .send({
          elements: [],
          files: {
            image: {
              dataURL: "data:image/png;base64,AQID",
              mimeType: "image/png",
            },
          },
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VERSION_CONFLICT");
      const current = await prisma.drawing.findUniqueOrThrow({
        where: { id: drawing.id },
      });
      expect(current.files).toBe("{}");
      expect(current.version).toBe(2);
      expect(
        await prisma.drawingSnapshot.count({
          where: { drawingId: drawing.id },
        }),
      ).toBe(0);
    },
  );

  it("preserves ordinary external image references without requiring stored rows", async () => {
    const drawing = await createDrawing();
    mountDrawingUpdates((files, userId, drawingId) =>
      internDrawingFiles(files, userId, drawingId, prisma),
    );
    const external = {
      dataURL: "https://external.example/image.png",
      mimeType: "image/png",
    };
    const res = await request(app)
      .put(`/drawings/${drawing.id}`)
      .send({ elements: [], files: { external } });
    expect(res.status).toBe(200);
    expect(res.body.files.external).toEqual(external);
    expect(
      await prisma.drawingFile.count({ where: { drawingId: drawing.id } }),
    ).toBe(0);
  });

  it("rejects a save when cleanup removes an image interned to a public S3 URL", async () => {
    vi.mocked(isS3Enabled).mockReturnValue(true);
    vi.mocked(getS3Config).mockReturnValue({
      publicUrl: "https://files.example",
    } as ReturnType<typeof getS3Config>);
    const drawing = await createDrawing();
    mountStorage();
    mountDrawingUpdates(async (files, userId, drawingId) => {
      const processed = await internDrawingFiles(
        files,
        userId,
        drawingId,
        prisma,
      );
      expect(processed.image.dataURL).toMatch(/^https:\/\/files.example\//);
      const trimmed = await request(app)
        .post(`/drawings/${drawingId}/trim`)
        .send({ confirmName: drawing.name });
      expect(trimmed.status).toBe(200);
      return processed;
    });
    const res = await request(app)
      .put(`/drawings/${drawing.id}`)
      .send({
        elements: [],
        files: {
          image: {
            dataURL: "data:image/png;base64,AQID",
            mimeType: "image/png",
          },
        },
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("VERSION_CONFLICT");
    expect(
      (await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } }))
        .files,
    ).toBe("{}");
  });

  it("rejects an existing public S3 reference reclaimed before a versionless save", async () => {
    vi.mocked(isS3Enabled).mockReturnValue(true);
    vi.mocked(getS3Config).mockReturnValue({
      publicUrl: "https://files.example",
    } as ReturnType<typeof getS3Config>);
    const drawing = await createDrawing();
    const image = {
      dataURL: "https://files.example/owner/drawing/image.png",
      mimeType: "image/png",
    };
    await prisma.drawingFile.create({
      data: {
        drawingId: drawing.id,
        fileId: "image",
        mimeType: "image/png",
        storage: "s3",
        s3Key: "owner/drawing/image.png",
      },
    });
    mountStorage();
    mountDrawingUpdates(async (files, userId, drawingId) => {
      const processed = await internDrawingFiles(
        files,
        userId,
        drawingId,
        prisma,
      );
      const trimmed = await request(app)
        .post(`/drawings/${drawingId}/trim`)
        .send({ confirmName: drawing.name });
      expect(trimmed.status).toBe(200);
      expect(await prisma.drawingFile.count({ where: { drawingId } })).toBe(0);
      return processed;
    });
    const saved = await request(app)
      .put(`/drawings/${drawing.id}`)
      .send({ elements: [], files: { image } });
    expect(saved.status).toBe(409);
    expect(saved.body.code).toBe("VERSION_CONFLICT");
    const current = await prisma.drawing.findUniqueOrThrow({
      where: { id: drawing.id },
    });
    expect(current.files).toBe("{}");
    expect(current.version).toBe(2);
    expect(
      await prisma.drawingSnapshot.count({ where: { drawingId: drawing.id } }),
    ).toBe(0);
  });

  it("keeps bytes that enter history before a conflicting save runs compensation", async () => {
    const drawing = await createDrawing();
    registerDrawingCreateUpdateRoutes(app, {
      prisma,
      requireAuth: auth,
      optionalAuth: auth,
      asyncHandler,
      parseJsonField,
      drawingUpdateSchema: z.object({
        elements: z.array(z.any()),
        files: z.record(z.string(), z.any()),
        version: z.number(),
      }),
      getRequestPrincipal: async () => ({ kind: "user", userId: ownerId }),
      respondWithAuthErrorIfPresent: () => false,
      invalidateDrawingsCache: vi.fn(),
      config: { nodeEnv: "test" },
      internDrawingFiles: async (
        files: Record<string, any>,
        userId: string,
        drawingId: string,
      ) => {
        const processed = await internDrawingFiles(
          files,
          userId,
          drawingId,
          prisma,
        );
        // Two successful saves happen after interning but before this request's
        // version guard. The second moves its image from live files to history.
        await applySceneUpdateTx({
          prisma,
          drawingId,
          parseJsonField,
          versionGuard: 1,
          mutate: () => ({ data: {}, incomingFiles: processed }),
        });
        await applySceneUpdateTx({
          prisma,
          drawingId,
          parseJsonField,
          versionGuard: 2,
          mutate: () => ({ data: { files: "{}" } }),
        });
        return processed;
      },
    } as unknown as DrawingRouteContext);
    const res = await request(app)
      .put(`/drawings/${drawing.id}`)
      .send({
        version: 1,
        elements: [],
        files: {
          image: {
            id: "image",
            mimeType: "image/png",
            dataURL: "data:image/png;base64,AQID",
          },
        },
      });
    expect(res.status).toBe(409);
    const current = await prisma.drawing.findUniqueOrThrow({
      where: { id: drawing.id },
    });
    expect(current.files).toBe("{}");
    expect(current.version).toBe(3);
    const row = await prisma.drawingFile.findUnique({
      where: { drawingId_fileId: { drawingId: drawing.id, fileId: "image" } },
    });
    expect(
      row?.data && Buffer.from(row.data).equals(Buffer.from([1, 2, 3])),
    ).toBe(true);
  });

  it.each(["trim", "orphans"])(
    "protects S3 history references during %s and deletes unrelated objects",
    async (operation) => {
      vi.mocked(isS3Enabled).mockReturnValue(true);
      const drawing = await createDrawing();
      const protectedKey = `${ownerId}/${drawing.id}/historical.png`;
      const orphanKey = `${ownerId}/${drawing.id}/orphan.png`;
      await prisma.drawingFile.createMany({
        data: [
          {
            drawingId: drawing.id,
            fileId: "historical",
            storage: "s3",
            s3Key: protectedKey,
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            drawingId: drawing.id,
            fileId: "orphan",
            storage: "s3",
            s3Key: orphanKey,
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      });
      await prisma.drawingSnapshot.create({
        data: {
          drawingId: drawing.id,
          version: 1,
          appState: "{}",
          elements: "[]",
          files: encodeSnapshotField(
            JSON.stringify({
              historical: {
                dataURL: `/api/files/${drawing.id}/historical`,
                description: "x".repeat(1000),
              },
            }),
          ),
        },
      });
      vi.mocked(listS3Objects).mockResolvedValue([
        { key: protectedKey, size: 3 },
        { key: orphanKey, size: 3 },
      ]);
      mountStorage();
      const res =
        operation === "trim"
          ? await request(app)
              .post(`/drawings/${drawing.id}/trim`)
              .send({ confirmName: drawing.name })
          : await request(app)
              .delete(`/drawings/${drawing.id}/files/orphans`)
              .send({
                confirmName: drawing.name,
                fileIds: ["historical", "orphan"],
              });
      expect(res.status).toBe(200);
      expect(deleteS3Object).toHaveBeenCalledExactlyOnceWith(orphanKey);
      const rows = await prisma.drawingFile.findMany({
        where: { drawingId: drawing.id },
      });
      expect(rows.map((row) => row.fileId)).toEqual(["historical"]);
    },
  );

  it("does not reupload immutable existing S3 bytes from a stale inline entry", async () => {
    vi.mocked(isS3Enabled).mockReturnValue(true);
    const drawing = await createDrawing();
    const key = `${ownerId}/${drawing.id}/image.png`;
    await prisma.drawingFile.create({
      data: {
        drawingId: drawing.id,
        fileId: "image",
        storage: "s3",
        s3Key: key,
        mimeType: "image/png",
        sizeBytes: 3,
      },
    });
    const processed = await internDrawingFiles(
      { image: { dataURL: "data:image/png;base64,AAAA" } },
      ownerId,
      drawing.id,
      prisma,
    );
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(processed.image.dataURL).toBe(`/api/files/${drawing.id}/image`);
    expect(
      (
        await prisma.drawingFile.findUniqueOrThrow({
          where: {
            drawingId_fileId: { drawingId: drawing.id, fileId: "image" },
          },
        })
      ).s3Key,
    ).toBe(key);
  });

  it("preserves existing managed bytes when later interning fails", async () => {
    const drawing = await createDrawing();
    const bytes = Buffer.from([1, 2, 3, 4]);
    await prisma.drawingFile.create({
      data: {
        drawingId: drawing.id,
        fileId: "existing",
        storage: "db",
        data: bytes,
        mimeType: "image/png",
        sizeBytes: bytes.length,
      },
    });
    const upsert = prisma.drawingFile.upsert.bind(prisma.drawingFile);
    const write = vi
      .spyOn(prisma.drawingFile, "upsert")
      .mockImplementation((args) => {
        if (args.where.drawingId_fileId?.fileId === "fail") {
          throw new Error("simulated storage failure");
        }
        return upsert(args);
      });
    const files: Record<string, any> = {
      existing: { dataURL: "data:image/png;base64,AAAA" },
    };
    // Complete the first batch before failing the next one; this exposes
    // an earlier overwrite even when interning never returns a scene payload.
    for (let i = 0; i < 7; i++) {
      files[`ref-${i}`] = { dataURL: "https://files.example/image.png" };
    }
    files.fail = { dataURL: "data:image/png;base64,AAAA" };
    try {
      await expect(
        internDrawingFiles(files, ownerId, drawing.id, prisma),
      ).rejects.toThrow("simulated storage failure");
      const row = await prisma.drawingFile.findUniqueOrThrow({
        where: {
          drawingId_fileId: { drawingId: drawing.id, fileId: "existing" },
        },
      });
      expect(row.data && Buffer.from(row.data).equals(bytes)).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it.each(["br1:broken", "not-json", "[]"])(
    "keeps all bytes when snapshot files cannot establish references (%s)",
    async (files) => {
      const drawing = await createDrawing();
      await prisma.drawingFile.create({
        data: {
          drawingId: drawing.id,
          fileId: "unknown",
          storage: "db",
          data: Buffer.from([1]),
          mimeType: "image/png",
          sizeBytes: 1,
        },
      });
      await prisma.drawingSnapshot.create({
        data: {
          drawingId: drawing.id,
          version: 1,
          elements: "[]",
          appState: "{}",
          files,
        },
      });
      expect(
        await collectRetainedDrawingFileIds(prisma, drawing.id),
      ).toBeNull();
      mountStorage();
      const res = await request(app)
        .post(`/drawings/${drawing.id}/trim`)
        .send({ confirmName: drawing.name });
      expect(res.status).toBe(200);
      expect(
        await prisma.drawingFile.count({ where: { drawingId: drawing.id } }),
      ).toBe(1);
    },
  );
});
