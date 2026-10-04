# Virtual Folders Specification

## Goal

Add S3-style virtual folders inside ExcaliDash collections without introducing a Folder entity or changing collections into a hierarchy.

Collections remain the top-level ownership, sharing, and permission boundary. Folder hierarchy is derived from a normalized path stored on each drawing.

## Data model

- Add a drawing path field with a root/default value of `/`.
- Existing drawings migrate/default to `/`, preserving existing behavior.
- Folder paths are normalized to lowercase. Drawing display names retain their original case.
- The maximum normalized path length is 1,024 characters.
- The backend storage type must provide ample capacity for Unicode representation; use a type capable of at least 16x the nominal 1,024-character path budget rather than a narrow byte-limited field.
- Do not create a Folder table/model.

Example:

```text
collection = NBF
path       = /das/architecture/
name       = Auth Flow
```

The UI presents this as `NBF / DAS / Architecture / Auth Flow`, while the persisted virtual folder path is lowercase.

## Folder semantics

- Folders are virtual prefixes only.
- Empty folders do not need persistent backend representation.
- A newly created empty folder may exist temporarily in browser/client state to make it convenient to navigate into it and create/import the first drawing.
- Once a drawing exists under the prefix, the folder naturally exists.
- If the final drawing/subtree under a virtual folder is removed, the folder disappears.
- Folder names may not contain `/`. Prefer sanitizing/replacing it with a codebase-consistent safe character such as `-` where appropriate.
- Follow existing codebase restrictions/sanitization for other characters.
- Normalize path segments and reject unsafe/ambiguous segments such as empty segments, `.`, and `..`.
- Folder paths are case-insensitive because persisted paths are lowercase.
- Drawing names remain case-sensitive; drawings that differ only by display-name case may coexist in the same normalized folder path.

## Rendering and navigation

- Keep the existing sidebar collection rendering unchanged.
- Virtual folders render only after entering a collection.
- In grid view, folders and drawings render together, folders first.
- If a list view exists, use the same folder-first behavior there.
- Use existing breadcrumb styling if the application already has an analogous breadcrumb component/style. Do not introduce a visually inconsistent breadcrumb system solely for this feature.
- Browser back/forward should work with folder navigation.
- Human-readable, URL-encoded paths are preferred in URLs. Do not introduce a path hash/lookup layer for this feature; if URL size becomes a practical problem, solve it separately.
- Creating a drawing while viewing a folder assigns the current normalized path.
- Importing a drawing while viewing a folder follows the existing collection-import behavior and assigns the current path.
- All Drawings remains flat and does not become a folder browser. Drawing cards/details there should show a small full collection/folder path for context.

## Moving and renaming

- Individual drawings can be moved through a hierarchical collection/folder picker.
- Virtual folders can be dragged/moved into other virtual folders.
- Folder moves may cross collections. Moving a folder across collections updates both the affected drawings' collection and path. Collection membership remains the permission boundary, so cross-collection moves intentionally inherit the destination collection's existing access/sharing behavior just like existing Move to Collection operations.
- Moving/renaming a virtual folder is a prefix rewrite over affected drawings; no folder record is created.
- Renaming a folder rewrites the relevant prefix while preserving drawing display-name case.
- Folder-prefix overlap is not itself a collision. Virtual folders with the same prefix naturally merge.

## Collision behavior

Collisions are evaluated at the complete resulting drawing path/name level, not at the virtual-folder level.

- Before create/move/rename operations, calculate each affected drawing's destination.
- A collision exists only when the resulting full drawing location/name conflicts with an existing drawing under the applicable case rules.
- Folder collisions do not exist as a separate concept.
- Moving one virtual folder into an existing folder with the same resulting prefix therefore merges naturally.
- For a multi-item operation, perform collision checks per item.
- If `folder1/folder1-2/drawing1`, `drawing2`, and `drawing3` are moved and individual destinations conflict, prompt/resolve each conflicting item individually rather than rejecting the entire operation solely because a virtual folder prefix already exists.
- Non-conflicting items should remain independently actionable.
- Multi-item moves/renames use a dry-run/plan phase. The dry-run performs no mutations and returns all calculated destinations and collisions.
- Present all collisions in one resolution dialog rather than a sequence of per-item dialogs.
- The collision dialog must support bulk actions so large moves are efficient: **Replace All**, **Skip All**, and **Rename All**. Users may override the bulk choice on any individual collision before committing.
- **Rename All** must generate deterministic, duplicate-safe destination drawing names and show the final proposed names in the dialog before commit. Generated names must be revalidated for collisions.
- **Replace** (individual or bulk) sends the existing destination drawing through normal Trash behavior and places the incoming drawing at the destination in the same transaction.
- **Skip** leaves the incoming drawing unchanged.
- After collision choices are resolved, re-run validation/dry-run and show the final operation plan before mutation.
- The backend must validate the submitted final plan again immediately before commit to protect against stale/concurrent changes.
- The final multi-item mutation is atomic: all approved moves/renames/replacements commit in one transaction or none do.

## Delete and Trash

- Deleting a virtual folder deletes/trashes all drawings contained under that prefix, including descendants.
- Require explicit confirmation before deleting the folder contents.
- Preserve existing ExcaliDash Trash semantics rather than inventing a separate folder deletion system.
- Trashing a drawing must not erase or rewrite its virtual path. Restore should therefore return the drawing to the same virtual path where existing collection restore behavior permits.
- Do not add folder-specific Trash records.

## Search

- All Drawings/global behavior remains flat.
- When searching from inside a virtual folder, scope results to that folder prefix and its descendants.
- Do not leak sibling/outside-folder results into a folder-scoped search.

## Permissions and sharing

- Collections remain the permission boundary.
- Do not add folder-level permissions.
- A user with collection access sees the collection's virtual folder structure according to their existing collection permissions.
- A drawing shared directly with a user does not grant access to sibling drawings or the containing virtual folder. In Shared With Me, display the directly shared drawing normally without exposing the surrounding hierarchy.

## Import/export

- Preserve virtual path metadata in ExcaliDash's internal collection/archive data where required for application backup/migration compatibility.
- Older internal archives with no path import drawings at `/`.
- Imported internal archives containing path metadata recreate the hierarchy automatically from drawing paths.
- User-facing drawing export remains `.excalidraw` only.
- Do not embed ExcaliDash virtual-folder metadata into standalone `.excalidraw` files solely for this feature.

## API compatibility

- Existing clients that do not provide a path behave as though path is `/`.
- Existing collection APIs and collection semantics should remain compatible.
- Responses may include the drawing path field.
- Avoid requiring existing integrations to understand virtual folders.
- Collections remain flat and continue to control ownership/sharing.

## Implementation principle

This feature should be a thin organizational layer over the existing drawing/collection model. Prefer path normalization, prefix operations, and UI derivation over introducing new persistent entities or recursively restructuring collections.
