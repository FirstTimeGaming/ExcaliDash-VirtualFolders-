export const MAX_VIRTUAL_PATH_LENGTH = 1024;

export class VirtualPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualPathError";
  }
}

/**
 * Normalize the persisted virtual folder prefix.
 *
 * Paths are metadata, not filesystem paths: they are always rooted, always end
 * in "/", and are lowercase so folder identity is case-insensitive. Drawing
 * names intentionally remain case-sensitive and are not handled here.
 */
export const normalizeVirtualPath = (input: unknown): string => {
  if (input === undefined || input === null || input === "") return "/";
  if (typeof input !== "string") {
    throw new VirtualPathError("Drawing path must be a string");
  }

  const rawSegments = input.replace(/\\/g, "/").split("/");
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed === "." || trimmed === "..") {
      throw new VirtualPathError("Drawing path contains an unsafe segment");
    }
    // Use locale-independent case folding so persisted folder identity is
    // deterministic across hosts. Slash is structural and backslashes were
    // normalized above, so each segment reaching this point is separator-free.
    segments.push(trimmed.toLowerCase());
  }

  const normalized = segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  if ([...normalized].length > MAX_VIRTUAL_PATH_LENGTH) {
    throw new VirtualPathError(
      `Drawing path exceeds ${MAX_VIRTUAL_PATH_LENGTH} characters`,
    );
  }
  return normalized;
};

export const joinVirtualPath = (parent: string, child: string): string =>
  normalizeVirtualPath(`${normalizeVirtualPath(parent)}${child}/`);

export const isWithinVirtualPath = (path: string, prefix: string): boolean =>
  normalizeVirtualPath(path).startsWith(normalizeVirtualPath(prefix));
