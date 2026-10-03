import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { rehydrateFilesFromUrls } from "../src/utils/rehydrateFiles";
import { useEditorCollaboration } from "../src/pages/editor/useEditorCollaboration";
const { sockets } = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("socket.io-client", () => ({ io: vi.fn(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const socket = { connected: true, handlers, ack: undefined as any,
    on: vi.fn((event, handler) => { handlers.set(event, handler); }), off: vi.fn((event) => handlers.delete(event)), disconnect: vi.fn(),
    emit: vi.fn((event, _payload, ack) => { if (event === "join-room") socket.ack = ack; }) };
  sockets.push(socket); return socket;
}) }));
vi.mock("../src/api", () => ({ getDrawing: vi.fn() }));
vi.mock("../src/utils/rehydrateFiles", () => ({ filesNeedRehydration: (files: any) => Object.values(files).some((file: any) => file.dataURL.startsWith("/api/")), rehydrateFilesFromUrls: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
const ref = <T,>(current: T) => ({ current });
const element = (id: string, version: number, extra = {}) => ({ id, type: "rectangle", version, versionNonce: version, updated: version, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const me = { id: "me", name: "Me", initials: "M", color: "red" };
let renderer: ReactTestRenderer | undefined;
let rafs: Map<number, FrameRequestCallback>;
const flushFrames = async () => { await act(async () => { const scheduled = [...rafs.values()]; rafs.clear(); scheduled.forEach((run) => run(0)); }); };
const makeHarness = () => {
  let live: any[] = [];
  const refs = { latestElementsRef: ref<readonly any[]>(live), latestFilesRef: ref<any>({}), lastSyncedFilesRef: ref({}), lastSyncedElementOrderSigRef: ref("") };
  const editor = { getSceneElementsIncludingDeleted: () => live, getAppState: () => ({ collaborators: new Map() }), addFiles: vi.fn(), updateScene: vi.fn((scene) => { if (scene.elements) live = scene.elements; }) };
  const input = { ...refs, me, isReady: true, excalidrawAPI: ref(editor), computeElementOrderSig: (els: readonly any[]) => els.map((el) => el.id).join(","), recordElementVersion: vi.fn(), onAccessDenied: vi.fn() };
  function Harness({ drawingId = "drawing" }: { drawingId?: string }) { useEditorCollaboration({ ...input, drawingId }); return null; }
  return { refs, editor, input, Harness, setLive: (els: any[]) => { live = els; refs.latestElementsRef.current = els; } };
};
beforeEach(() => {
  vi.clearAllMocks(); sockets.length = 0; rafs = new Map(); let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => { rafs.set(++nextFrame, run); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafs.delete(id));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { origin: "http://example.test", reload: vi.fn() } }));
  vi.stubGlobal("document", new EventTarget());
  vi.mocked(api.getDrawing).mockResolvedValue({ elements: [], files: {} } as never);
  vi.mocked(rehydrateFilesFromUrls).mockImplementation(async (files) => files || {});
});
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
const mount = async (Harness: React.ComponentType) => { await act(async () => { renderer = create(<Harness />); }); };
describe("remote collaboration staging", () => {
  it("keeps the newest delta when an older packet arrives before the animation flush", async () => {
    const h = makeHarness(); await mount(h.Harness);
    sockets[0].handlers.get("element-update")({ elements: [element("peer", 3)] });
    sockets[0].handlers.get("element-update")({ elements: [element("peer", 1)] });
    await flushFrames(); expect(h.refs.latestElementsRef.current).toEqual([element("peer", 3)]);
    expect(h.input.recordElementVersion).toHaveBeenCalledWith(element("peer", 3));
  });
  it("ignores an old drawing's delayed image hydration after navigation", async () => {
    const h = makeHarness(); await mount(h.Harness); const files = deferred<any>(); vi.mocked(rehydrateFilesFromUrls).mockReturnValueOnce(files.promise);
    sockets[0].handlers.get("element-update")({ elements: [], files: { old: { id: "old", dataURL: "/api/files/drawing/old" } } });
    await act(async () => { renderer!.update(<h.Harness drawingId="other" />); });
    await act(async () => { files.resolve({ old: { id: "old", dataURL: "data:old" } }); await files.promise; });
    await flushFrames(); expect(h.refs.latestFilesRef.current).toEqual({}); expect(h.editor.addFiles).not.toHaveBeenCalled();
  });
  it("keeps newer inline bytes when an earlier hydration finishes later", async () => {
    const h = makeHarness(); await mount(h.Harness); const files = deferred<any>(); vi.mocked(rehydrateFilesFromUrls).mockReturnValueOnce(files.promise);
    sockets[0].handlers.get("element-update")({ elements: [], files: { image: { id: "image", dataURL: "/api/files/drawing/image" } } });
    const newer = { image: { id: "image", dataURL: "data:new" } };
    sockets[0].handlers.get("element-update")({ elements: [], files: newer }); await flushFrames();
    await act(async () => { files.resolve({ image: { id: "image", dataURL: "data:old" } }); await files.promise; });
    await flushFrames(); expect(h.refs.latestFilesRef.current).toEqual(newer);
  });
  it("catches up missed persisted peer edits on each room join while preserving unsaved local work", async () => {
    const h = makeHarness(); await mount(h.Harness); h.setLive([element("local", 2)]);
    vi.mocked(api.getDrawing).mockResolvedValue({ elements: [element("peer", 3)], files: {} } as never);
    await act(async () => { sockets[0].ack({ user: me }); }); await flushFrames();
    expect(h.refs.latestElementsRef.current).toEqual(expect.arrayContaining([element("peer", 3), element("local", 2)]));
    vi.mocked(api.getDrawing).mockResolvedValue({ elements: [element("peer", 4, { isDeleted: true })], files: {} } as never);
    sockets[0].handlers.get("connect")(); await act(async () => { sockets[0].ack({ user: me }); }); await flushFrames();
    expect(h.refs.latestElementsRef.current).toEqual(expect.arrayContaining([element("peer", 4, { isDeleted: true }), element("local", 2)]));
    expect(api.getDrawing).toHaveBeenCalledTimes(2);
  });
  it("keeps local live geometry and newly received image bytes over a delayed catchup snapshot", async () => {
    const h = makeHarness(); await mount(h.Harness);
    const response = deferred<any>(); vi.mocked(api.getDrawing).mockReturnValueOnce(response.promise);
    sockets[0].ack({ user: me });
    h.setLive([element("live", 1, { x: 100 })]);
    const files = { image: { id: "image", dataURL: "data:new" } };
    sockets[0].handlers.get("element-update")({ elements: [], files }); await flushFrames();
    await act(async () => { response.resolve({ elements: [element("live", 1, { x: 0 })], files: { image: { id: "image", dataURL: "data:old" } } }); await response.promise; });
    await flushFrames();
    expect(h.refs.latestElementsRef.current).toEqual([element("live", 1, { x: 100 })]);
    expect(h.refs.latestFilesRef.current).toEqual(files);
  });
  it("ignores room catchup reads that finish after switching drawings", async () => {
    const h = makeHarness(); await mount(h.Harness); const response = deferred<any>(); vi.mocked(api.getDrawing).mockReturnValueOnce(response.promise);
    sockets[0].ack({ user: me }); await act(async () => { renderer!.update(<h.Harness drawingId="other" />); });
    await act(async () => { response.resolve({ elements: [element("old", 2)], files: {} }); await response.promise; });
    await flushFrames(); expect(h.refs.latestElementsRef.current).toEqual([]);
  });
});
