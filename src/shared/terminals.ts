import type { AiswitchToolId } from "./aiswitch";

/** A terminal running inside the app. Output arrives as numbered chunks (`seq`). */
export type TerminalInfo = {
  id: string;
  tool: AiswitchToolId;
  folderId: string;
  folderName: string;
  cwd: string;
  title: string;
  startedAt: number;
  running: boolean;
  exitCode: number | null;
  /** Sequence number of the latest output chunk. */
  seq: number;
  /** Windows build number when the terminal runs on ConPTY, so xterm.js can match its line handling. */
  windowsBuild?: number;
};

/** Where folder terminals open: inside the app, or in the system's terminal app. */
export type TerminalPlacement = "inside" | "outside";
