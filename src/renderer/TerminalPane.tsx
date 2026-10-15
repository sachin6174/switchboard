import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SwitchboardApi, TerminalInfo } from "./api";

const THEME = {
  background: "#0f171b",
  foreground: "#ecf2f3",  // bright enough that half-strength (dim) text still passes AA
  cursor: "#8fdcc8",
  selectionBackground: "#2c4a47",
  black: "#1c292e", red: "#ef8a7a", green: "#8fdcc8", yellow: "#f0cf8e",
  blue: "#8cb8f0", magenta: "#d3a6f0", cyan: "#7fd6e0", white: "#ecf2f3",
  brightBlack: "#52666e", brightRed: "#f6a89b", brightGreen: "#b2ead9", brightYellow: "#f6dfae",
  brightBlue: "#aecdf5", brightMagenta: "#e2c2f5", brightCyan: "#a6e5ec", brightWhite: "#ffffff",
};

/**
 * One in-app terminal drawn with xterm.js. Output already produced is redrawn from the main
 * process's buffer, then live chunks follow; sequence numbers keep chunks from being lost or
 * repeated. Typing goes to the program; the pty follows the pane's size.
 */
export function TerminalPane({ api, info, visible }: { api: SwitchboardApi; info: TerminalInfo; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, ui-monospace, Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      // Keep every colour a CLI picks readable against the background (WCAG AA).
      minimumContrastRatio: 4.5,
      theme: THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host.current!);
    term.current = terminal;
    fit.current = fitAddon;

    let shownSeq = -1;
    const early: Array<{ seq: number; data: string }> = [];
    const offData = api.onTerminalData((event) => {
      if (event.id !== info.id) return;
      if (shownSeq < 0) early.push(event);
      else if (event.seq > shownSeq) { terminal.write(event.data); shownSeq = event.seq; }
    });
    void api.terminalBuffer(info.id).then((buffer) => {
      terminal.write(buffer.data);
      shownSeq = buffer.seq;
      for (const event of early) if (event.seq > shownSeq) { terminal.write(event.data); shownSeq = event.seq; }
      early.length = 0;
    }).catch(() => { shownSeq = 0; });

    const input = terminal.onData((data) => { void api.writeTerminal(info.id, data).catch(() => undefined); });
    let timer: number | undefined;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!host.current || host.current.offsetWidth === 0) return;
        fitAddon.fit();
        void api.resizeTerminal(info.id, terminal.cols, terminal.rows).catch(() => undefined);
      }, 60);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    resize();
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      offData();
      terminal.dispose();
      term.current = null;
    };
  }, [api, info.id]);

  useEffect(() => {
    if (!visible) return;
    const handle = window.setTimeout(() => {
      fit.current?.fit();
      if (term.current) void api.resizeTerminal(info.id, term.current.cols, term.current.rows).catch(() => undefined);
      term.current?.focus();
    }, 30);
    return () => window.clearTimeout(handle);
  }, [visible, api, info.id]);

  return <div className="term-host" ref={host} aria-label={`${info.title} terminal`} />;
}
