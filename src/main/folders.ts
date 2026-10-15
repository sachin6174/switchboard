import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProjectFolder } from "../shared/folders";

/**
 * Project folders the user added. Opening one starts Claude Code, Codex and agy in that folder.
 * Kept as a small JSON file in the app's data directory so the list survives restarts.
 */

export class FolderError extends Error {
  constructor(public code: "NOT_FOUND" | "NOT_A_FOLDER", message: string) {
    super(message);
    this.name = "FolderError";
  }
}

type Stored = { id: string; path: string; addedAt: number; lastOpenedAt: number | null };

function isStored(value: unknown): value is Stored {
  const item = value as Stored;
  return !!item && typeof item.id === "string" && typeof item.path === "string" && typeof item.addedAt === "number";
}

function canonical(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

export class FolderStore {
  private readonly file: string;

  constructor(userDataPath: string) {
    this.file = path.join(userDataPath, "project-folders.v1.json");
  }

  list(): ProjectFolder[] {
    return this.read().map((item) => ({
      ...item,
      name: path.basename(item.path) || item.path,
      missing: !this.isDirectory(item.path),
    }));
  }

  /** Adds a folder, or returns the existing entry when it's already in the list. */
  add(folder: string): ProjectFolder {
    if (typeof folder !== "string" || !path.isAbsolute(folder) || !this.isDirectory(folder)) {
      throw new FolderError("NOT_A_FOLDER", "Choose an existing folder.");
    }
    const resolved = canonical(folder);
    const items = this.read();
    let item = items.find((entry) => canonical(entry.path) === resolved);
    if (!item) {
      item = { id: randomUUID(), path: resolved, addedAt: Date.now(), lastOpenedAt: null };
      items.push(item);
      this.write(items);
    }
    return this.list().find((entry) => entry.id === item!.id)!;
  }

  remove(id: string): void {
    this.write(this.read().filter((item) => item.id !== id));
  }

  /** The folder to open, which must still exist; records when it was opened. */
  open(id: string): ProjectFolder {
    const items = this.read();
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new FolderError("NOT_FOUND", "That folder is no longer in the list.");
    if (!this.isDirectory(item.path)) throw new FolderError("NOT_FOUND", `The folder ${item.path} doesn't exist any more.`);
    item.lastOpenedAt = Date.now();
    this.write(items);
    return this.list().find((entry) => entry.id === id)!;
  }

  private isDirectory(folder: string): boolean {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  }

  private read(): Stored[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isStored) : [];
    } catch {
      return [];
    }
  }

  private write(items: Stored[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(items, null, 2));
    renameSync(tmp, this.file);
  }
}
