/**
 * Graphify workspace operations for the VS Code host.
 *
 * Offline-safe default: `extract --code-only` (AST). Full extract needs an LLM
 * backend and can exit 0 without writing graph.json — we always verify the file.
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { isExternalGraphPath, workspaceRoot } from "./config";
import { curatedProcessEnv } from "./envCurate";
import { ensureCompanions, probeGraphify } from "./companionDeps";

export type GraphifyMode = "extract_code" | "extract_full" | "update";

export type GraphifyStatus = {
  workspace?: string;
  packageOk: boolean;
  packageDetail: string;
  packageVersion?: string;
  graphPath: string;
  graphExists: boolean;
  nodeCount?: number;
  linkCount?: number;
  upstreamPath: string;
  upstreamExists: boolean;
  preferredPath: string;
  ready: boolean;
  hint: string;
};

function preferredGraphDir(root: string): string {
  return path.join(root, ".clawagents", "graphify");
}

function preferredGraphPath(root: string): string {
  return path.join(preferredGraphDir(root), "graph.json");
}

function upstreamGraphPath(root: string): string {
  return path.join(root, "graphify-out", "graph.json");
}

/**
 * Node/link counts are cosmetic, but this runs synchronously on the extension
 * host from `getGraphifyStatus`. Reading and parsing a multi-megabyte graph
 * there freezes the UI thread, so skip the parse past a size the main thread
 * can absorb — the counts are optional and the caller renders without them.
 */
const MAX_GRAPH_STAT_BYTES = 8 * 1024 * 1024;

function readGraphStats(graphFile: string): { nodes?: number; links?: number } {
  try {
    if (fs.statSync(graphFile).size > MAX_GRAPH_STAT_BYTES) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(graphFile, "utf8")) as {
      nodes?: unknown;
      links?: unknown;
    };
    return {
      nodes: Array.isArray(raw.nodes) ? raw.nodes.length : undefined,
      links: Array.isArray(raw.links) ? raw.links.length : undefined,
    };
  } catch {
    return {};
  }
}

export function getGraphifyStatus(python: string): GraphifyStatus {
  const root = workspaceRoot();
  const probe = probeGraphify(python);
  const preferred = root ? preferredGraphPath(root) : "";
  const upstream = root ? upstreamGraphPath(root) : "";
  const preferredExists = Boolean(preferred && fs.existsSync(preferred));
  const upstreamExists = Boolean(upstream && fs.existsSync(upstream));
  const active = preferredExists ? preferred : upstreamExists ? upstream : preferred;
  const exists = Boolean(active && fs.existsSync(active));
  const stats = exists ? readGraphStats(active) : {};
  let hint = "ok";
  if (!probe.ok) {
    hint = "Install graphifyy into sidecar Python (Ensure Companions).";
  } else if (!exists) {
    hint =
      "No graph yet — Build graph (code-only) or Use existing graphify-out/.";
  } else if (!preferredExists && upstreamExists) {
    hint = "Serving upstream graphify-out/; adopt into .clawagents/graphify for ClawAgents layout.";
  }
  return {
    workspace: root,
    packageOk: probe.ok,
    packageDetail: probe.detail,
    packageVersion: probe.version,
    graphPath: active,
    graphExists: exists,
    nodeCount: stats.nodes,
    linkCount: stats.links,
    upstreamPath: upstream,
    upstreamExists,
    preferredPath: preferred,
    ready: probe.ok && exists,
    hint,
  };
}

/**
 * Provider credentials for the LLM-backed full extract only.
 *
 * `curatedProcessEnv()` deliberately strips API keys, so the one graphify mode
 * that documents "needs LLM API keys in the environment" re-adds just those —
 * rather than handing every key to every subprocess.
 */
function llmProviderEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
  ]) {
    const v = process.env[k];
    if (v) {
      out[k] = v;
    }
  }
  return out;
}

function runPython(
  python: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    output?: { appendLine(s: string): void };
  },
): Promise<{ code: number | null; log: string }> {
  return new Promise((resolve) => {
    opts.output?.appendLine(`$ ${python} ${args.join(" ")}`);
    // Curated env only: raw process.env forwards PYTHONPATH / PYTHONSTARTUP /
    // LD_PRELOAD (and every provider API key) into the graphify interpreter,
    // which is code injection into a subprocess we control — see envCurate.ts.
    // No `shell`: spawn() with an argv array needs none, and cmd.exe would both
    // split interpreter paths containing spaces and treat `>=` / `&` in args as
    // redirects and command separators.
    const child = spawn(python, args, {
      cwd: opts.cwd,
      env: { ...curatedProcessEnv(), ...opts.env },
    });
    let log = "";
    const onData = (buf: Buffer) => {
      const t = buf.toString();
      log += t;
      for (const line of t.split(/\r?\n/)) {
        if (line.trim()) {
          opts.output?.appendLine(line);
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      opts.output?.appendLine(`spawn error: ${err.message}`);
      resolve({ code: 1, log: log + err.message });
    });
    child.on("exit", (code) => resolve({ code, log }));
  });
}

export async function ensureGraphifyPackage(
  python: string,
  output?: { appendLine(s: string): void },
): Promise<boolean> {
  const probe = probeGraphify(python);
  if (probe.ok) {
    return true;
  }
  if (!output) {
    return false;
  }
  const results = await ensureCompanions(output, { force: true, python });
  const gf = results.find((r) => r.name === "graphify");
  return Boolean(gf?.ok);
}

/** Copy/symlink upstream graphify-out into .clawagents/graphify. */
export async function adoptUpstreamGraph(
  python: string,
  output?: { appendLine(s: string): void },
): Promise<GraphifyStatus | undefined> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Open a workspace folder first.");
    return undefined;
  }
  const src = upstreamGraphPath(root);
  if (!fs.existsSync(src)) {
    void vscode.window.showWarningMessage(
      `No existing graph at ${src}. Build one with Graphify — Build graph (code-only).`,
    );
    return getGraphifyStatus(python);
  }
  const destDir = preferredGraphDir(root);
  const dest = preferredGraphPath(root);
  const confirm = await vscode.window.showWarningMessage(
    `Copy existing graph into ClawAgents layout?\n\nFrom: ${src}\nTo: ${dest}`,
    { modal: true },
    "Copy",
    "Cancel",
  );
  if (confirm !== "Copy") {
    return undefined;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  // Best-effort: retain Graphify's adjacent report/metadata so future updates
  // can keep the same graph context after adoption.
  for (const name of [
    "GRAPH_REPORT.md",
    "graph.html",
    ".graphify_analysis.json",
    ".graphify_labels.json",
    ".graphify_root",
  ]) {
    const a = path.join(path.dirname(src), name);
    if (fs.existsSync(a)) {
      fs.copyFileSync(a, path.join(destDir, name));
    }
  }
  output?.appendLine(`Adopted ${src} → ${dest}`);
  void vscode.window.showInformationMessage(`Graphify: using ${dest}`);
  return getGraphifyStatus(python);
}

export async function runGraphifyMode(
  python: string,
  mode: GraphifyMode,
  output?: { appendLine(s: string): void },
  opts?: { skipConfirm?: boolean },
): Promise<GraphifyStatus> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("ClawAgents Graphify: open a workspace folder first.");
    return getGraphifyStatus(python);
  }

  if (!(await ensureGraphifyPackage(python, output))) {
    const choice = await vscode.window.showWarningMessage(
      `Graphify package missing in sidecar Python.\n${probeGraphify(python).detail}`,
      { modal: true },
      "Ensure Companions",
      "Cancel",
    );
    if (choice === "Ensure Companions") {
      await ensureGraphifyPackage(python, output ?? { appendLine: () => undefined });
    }
    return getGraphifyStatus(python);
  }

  const labels: Record<GraphifyMode, string> = {
    extract_code:
      "Build knowledge graph from code (AST, offline — recommended). Docs/images skipped.",
    extract_full:
      "Full extract including docs (needs LLM API keys in the environment). May fail without openai.",
    update: "Augment graph with code changes (AST update — no LLM).",
  };
  if (!opts?.skipConfirm) {
    const confirm = await vscode.window.showWarningMessage(
      `${labels[mode]}\n\nWorkspace: ${root}\nOutput: .clawagents/graphify/graph.json`,
      { modal: true },
      "Run",
      "Cancel",
    );
    if (confirm !== "Run") {
      return getGraphifyStatus(python);
    }
  }

  const graphOut = preferredGraphDir(root);
  fs.mkdirSync(graphOut, { recursive: true });
  const args =
    mode === "extract_code"
      ? ["-m", "graphify", "extract", ".", "--code-only"]
      : mode === "extract_full"
        ? ["-m", "graphify", "extract", "."]
        : ["-m", "graphify", "update", "."];

  const title =
    mode === "update"
      ? "ClawAgents: Graphify — Augment graph…"
      : mode === "extract_full"
        ? "ClawAgents: Graphify — Full extract…"
        : "ClawAgents: Graphify — Build graph (code)…";

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => {
      output?.appendLine(`=== graphify ${mode} @ ${root} ===`);
      const result = await runPython(python, args, {
        cwd: root,
        // Only the LLM-backed `extract_full` gets provider keys; `--code-only`
        // and `update` are pure-AST and must not see credentials at all.
        env: {
          GRAPHIFY_OUT: graphOut,
          ...(mode === "extract_full" ? llmProviderEnv() : {}),
        },
        output,
      });
      const graphFile = preferredGraphPath(root);
      const wrote = fs.existsSync(graphFile);
      if (result.code !== 0 || !wrote) {
        const reason =
          result.code !== 0
            ? `Graphify failed (exit ${result.code ?? "unknown"}). The existing graph was left untouched to avoid serving stale data.`
            : `Graphify finished but did not write ${graphFile}.`;
        void vscode.window.showErrorMessage(
          `${reason} ` +
            (mode === "extract_full"
              ? "Full extract needs an LLM backend (openai/etc). Use Build graph (code-only) instead."
              : "See ClawAgents Sidecar output for details."),
        );
        output?.appendLine(
          `ERROR: graphify ${mode} failed (exit ${result.code}); refusing to serve a possibly stale graph.\n` +
            result.log.slice(-2_000),
        );
        return;
      }
      const stats = readGraphStats(graphFile);
      void vscode.window.showInformationMessage(
        `Graphify ready — ${stats.nodes ?? "?"} nodes` +
          (stats.links != null ? `, ${stats.links} links` : "") +
          ` → ${graphFile}`,
      );
    },
  );

  return getGraphifyStatus(python);
}

/** Merge selected graphs into a new, opt-in graph without touching their sources. */
export async function mergeGraphifyGraphs(
  python: string,
  graphFiles: string[],
  output?: { appendLine(s: string): void },
): Promise<string | undefined> {
  const root = workspaceRoot();
  if (!root || graphFiles.length < 2) {
    return undefined;
  }
  const outDir = path.join(preferredGraphDir(root), "merged");
  const outFile = path.join(outDir, "graph.json");
  // The merged output lands inside the workspace, so the external-graph prompt
  // in useGraphifySource() will see a local path and stay silent. Warn here
  // instead — otherwise picking one outside graph launders its contents into a
  // "trusted internal" path with no prompt ever shown.
  const externalSources = graphFiles.filter((file) => isExternalGraphPath(file));
  if (externalSources.length > 0) {
    const shown = externalSources.slice(0, 5).map((f) => `  • ${f}`).join("\n");
    const more =
      externalSources.length > 5
        ? `\n  …and ${externalSources.length - 5} more`
        : "";
    const trust = await vscode.window.showWarningMessage(
      `${externalSources.length} of ${graphFiles.length} selected graphs are outside this workspace. ` +
        `Their contents will be merged into a workspace graph and may be returned to the agent.\n\n${shown}${more}`,
      { modal: true },
      "Merge anyway",
      "Cancel",
    );
    if (trust !== "Merge anyway") {
      return undefined;
    }
  }
  const confirm = await vscode.window.showWarningMessage(
    `Merge ${graphFiles.length} graphs into a new ClawAgents graph?\n\nOutput: ${outFile}\nSource graphs are not modified.`,
    { modal: true },
    "Merge",
    "Cancel",
  );
  if (confirm !== "Merge") {
    return undefined;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const result = await runPython(
    python,
    ["-m", "graphify", "merge-graphs", ...graphFiles, "--out", outFile],
    { cwd: root, output },
  );
  if (result.code !== 0 || !fs.existsSync(outFile)) {
    void vscode.window.showErrorMessage("Graphify could not merge the selected graphs. See Sidecar output.");
    output?.appendLine(`ERROR: graph merge failed (exit ${result.code}).\n${result.log.slice(-2_000)}`);
    return undefined;
  }
  fs.writeFileSync(
    path.join(outDir, "merge-manifest.json"),
    `${JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sources: graphFiles.map((file) => path.resolve(file)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return outFile;
}

export async function openGraphifyFolder(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const preferred = preferredGraphDir(root);
  const upstream = path.join(root, "graphify-out");
  const dir = fs.existsSync(preferred)
    ? preferred
    : fs.existsSync(upstream)
      ? upstream
      : preferred;
  fs.mkdirSync(dir, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}
