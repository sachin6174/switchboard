/** A project folder the user added. Opening it starts the coding CLIs in that folder. */
export type ProjectFolder = {
  id: string;
  /** Absolute path. */
  path: string;
  /** Folder name, for display. */
  name: string;
  addedAt: number;
  lastOpenedAt: number | null;
  /** The folder was moved or deleted since it was added. */
  missing: boolean;
};
