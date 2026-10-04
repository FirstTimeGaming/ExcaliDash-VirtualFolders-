import { describe, expect, it } from "vitest";
import {
  MAX_VIRTUAL_PATH_LENGTH,
  VirtualPathError,
  isWithinVirtualPath,
  joinVirtualPath,
  normalizeVirtualPath,
} from "./virtualFolders";

describe("virtual folder paths", () => {
  it("uses root for missing and empty paths", () => {
    expect(normalizeVirtualPath(undefined)).toBe("/");
    expect(normalizeVirtualPath("")).toBe("/");
    expect(normalizeVirtualPath("/")).toBe("/");
  });

  it("canonicalizes folder identity to lowercase with root and trailing slash", () => {
    expect(normalizeVirtualPath(" DAS / Architecture ")).toBe(
      "/das/architecture/",
    );
    expect(normalizeVirtualPath("/DAS//Architecture/")).toBe(
      "/das/architecture/",
    );
  });

  it("normalizes backslashes as structural separators", () => {
    expect(normalizeVirtualPath("DAS\\Architecture")).toBe(
      "/das/architecture/",
    );
  });

  it("rejects dot traversal segments", () => {
    expect(() => normalizeVirtualPath("/das/../private/")).toThrow(
      VirtualPathError,
    );
    expect(() => normalizeVirtualPath("/das/./private/")).toThrow(
      VirtualPathError,
    );
  });

  it("enforces the 1024-character normalized path limit by Unicode code point", () => {
    const exactSegment = "a".repeat(MAX_VIRTUAL_PATH_LENGTH - 2);
    expect([...normalizeVirtualPath(exactSegment)]).toHaveLength(
      MAX_VIRTUAL_PATH_LENGTH,
    );
    expect(() =>
      normalizeVirtualPath("a".repeat(MAX_VIRTUAL_PATH_LENGTH - 1)),
    ).toThrow(VirtualPathError);

    const emojiSegment = "😀".repeat(MAX_VIRTUAL_PATH_LENGTH - 2);
    expect([...normalizeVirtualPath(emojiSegment)]).toHaveLength(
      MAX_VIRTUAL_PATH_LENGTH,
    );
  });

  it("joins and compares normalized virtual prefixes", () => {
    expect(joinVirtualPath("/DAS/", "Architecture")).toBe(
      "/das/architecture/",
    );
    expect(
      isWithinVirtualPath("/DAS/Architecture/Auth/", "/das/architecture/"),
    ).toBe(true);
    expect(isWithinVirtualPath("/dashboard/", "/das/")).toBe(false);
  });
});
