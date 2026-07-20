import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  buildProblemsContext,
  ExtensionConfig,
  setPreferredWorkspaceRoot,
  trackEditorFocus,
  wrapCurrentFileRef,
  wrapSelectionBlock,
  workspaceRoot,
  workspaceRoots,
} from "./config";
import { ensureCompanions, probeCompanions, probeGraphify } from "./companionDeps";
import {
  ensureSidecarDeps,
  MIN_CLAWAGENTS_VERSION_STR,
  SIDECAR_PIP_PACKAGES,
} from "./pythonDeps";
import {
  ensurePathPythonFloor,
  formatDriftWarning,
  probePathInterpreterDrift,
} from "./pythonPathPin";
import { SidecarManager } from "./sidecar";
import { ClawAgentsWebviewProvider } from "./webviewProvider";

const GRAPHIFY_AGENTS_BLOCK = `<!-- graphify-clawagents -->
## Graphify

Prefer Graphify knowledge-graph tools (\`query_graph\`, \`shortest_path\`, \`god_nodes\`) before bulk file reads when asking architecture or dependency questions. Graph lives at \`.clawagents/graphify/graph.json\` (or \`graphify-out/graph.json\`). Do not paste graph.json into prompts — query it.
<!-- /graphify-clawagents -->
`;

async function runGraphifyWorkspaceCommand(
  config: ExtensionConfig,
  mgr: SidecarManager | undefined,
  mode: "extract" | "update",
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("ClawAgents Graphify: open a workspace folder first.");
    return;
  }
  const out = mgr?.output;
  const python = config.pythonPath;
  const probe = probeGraphify(python);
  if (!probe.ok) {
    const choice = await vscode.window.showWarningMessage(
      `Graphify package missing or below floor in sidecar Python.\n${probe.detail}`,
      { modal: true },
      "Ensure Companions",
      "Cancel",
    );
    if (choice === "Ensure Companions") {
      await vscode.commands.executeCommand("clawagents.ensureCompanions");
    }
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Run \`python -m graphify ${mode} .\` in:\n${root}\n\nOutput: .clawagents/graphify/`,
    { modal: true },
    "Run",
    "Cancel",
  );
  if (confirm !== "Run") {
    return;
  }
  const graphOut = path.join(root, ".clawagents", "graphify");
  fs.mkdirSync(graphOut, { recursive: true });
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ClawAgents: graphify ${mode}…`,
      cancellable: false,
    },
    async () =>
      new Promise<void>((resolve) => {
        out?.appendLine(`=== graphify ${mode} @ ${root} ===`);
        const child = spawn(python, ["-m", "graphify", mode, "."], {
          cwd: root,
          env: {
            ...process.env,
            GRAPHIFY_OUT: graphOut,
          },
          shell: process.platform === "win32",
        });
        const onData = (buf: Buffer) => {
          for (const line of buf.toString().split(/\r?\n/)) {
            if (line.trim()) {
              out?.appendLine(line);
            }
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (err) => {
          void vscode.window.showErrorMessage(`graphify ${mode} failed: ${err.message}`);
          resolve();
        });
        child.on("exit", (code) => {
          if (code === 0) {
            void vscode.window.showInformationMessage(
              `Graphify ${mode} finished → ${path.join(graphOut, "graph.json")}`,
            );
          } else {
            void vscode.window.showErrorMessage(
              `graphify ${mode} exited ${code} — see ClawAgents Sidecar output.`,
            );
          }
          resolve();
        });
      }),
  );
}

async function appendGraphifyAgentsBlock(): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Open a workspace folder first.");
    return;
  }
  const agentsPath = path.join(root, "AGENTS.md");
  const confirm = await vscode.window.showWarningMessage(
    `Append Graphify routing block to ${agentsPath}?`,
    { modal: true },
    "Append",
    "Cancel",
  );
  if (confirm !== "Append") {
    return;
  }
  let existing = "";
  try {
    existing = fs.readFileSync(agentsPath, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes("<!-- graphify-clawagents -->")) {
    void vscode.window.showInformationMessage("AGENTS.md already has the Graphify block.");
    return;
  }
  const next = existing.trimEnd()
    ? `${existing.trimEnd()}\n\n${GRAPHIFY_AGENTS_BLOCK}`
    : GRAPHIFY_AGENTS_BLOCK;
  fs.writeFileSync(agentsPath, next, "utf8");
  void vscode.window.showInformationMessage(`Appended Graphify block to ${agentsPath}`);
}

let sidecar: SidecarManager | undefined;
let provider: ClawAgentsWebviewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // VS Code: Secondary Side Bar (right) — same strip as Claude Code / Codex.
  // Cursor Glass: Activity Bar fallback (no reliable secondary sidebar for 3rd-party).
  const isCursor = vscode.env.appName.toLowerCase().includes("cursor");
  void vscode.commands.executeCommand("setContext", "clawagents:useActivityBar", isCursor);
  if (!isCursor) {
    // Explicitly keep Secondary Side Bar for VS Code even if aux probe races.
    void vscode.commands.executeCommand("setContext", "clawagents:useActivityBar", false);
  } else {
    void (async () => {
      const cmds = await vscode.commands.getCommands(true);
      const hasAux =
        cmds.includes("workbench.action.focusAuxiliaryBar") ||
        cmds.includes("workbench.action.toggleAuxiliaryBar");
      // If somehow Cursor reports a working aux bar, still prefer Activity Bar to
      // avoid the known "secondary sidebar not supported" blank panel.
      void hasAux;
      await vscode.commands.executeCommand("setContext", "clawagents:useActivityBar", true);
    })();
  }

  const config = new ExtensionConfig(context.secrets);
  const savedRoot = context.workspaceState.get<string>("clawagents.preferredWorkspaceRoot");
  if (!setPreferredWorkspaceRoot(savedRoot)) {
    setPreferredWorkspaceRoot(undefined);
  }
  // Freeze the initial active/first folder so editor focus cannot silently
  // move an already-running sidecar to a different trust/workspace scope.
  const initialRoot = workspaceRoot();
  if (initialRoot) {
    setPreferredWorkspaceRoot(initialRoot);
    void context.workspaceState.update("clawagents.preferredWorkspaceRoot", initialRoot);
  }
  sidecar = new SidecarManager(
    context.extensionPath,
    config,
    context.globalStorageUri.fsPath,
  );
  provider = new ClawAgentsWebviewProvider(context, sidecar, config);

  trackEditorFocus(context.subscriptions);

  const webviewOpts = { webviewOptions: { retainContextWhenHidden: true } };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("clawagents.sidebar", provider, webviewOpts),
    vscode.window.registerWebviewViewProvider("clawagents.sidebarActivity", provider, webviewOpts),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("clawagents.openChat", async () => {
      await provider?.openChat();
    }),
    vscode.commands.registerCommand("clawagents.toggleChat", async () => {
      await provider?.toggleChat();
    }),
    vscode.commands.registerCommand("clawagents.newChat", async () => {
      await provider?.openChat();
      await provider?.newChat();
    }),
    vscode.commands.registerCommand("clawagents.addSelectionToChat", async () => {
      const wrapped = wrapSelectionBlock();
      if (!wrapped) {
        return;
      }
      await provider?.addSelection(wrapped);
    }),
    vscode.commands.registerCommand("clawagents.addFileToChat", async () => {
      const wrapped = wrapCurrentFileRef();
      if (!wrapped) {
        return;
      }
      await provider?.addSelection(wrapped);
    }),
    vscode.commands.registerCommand("clawagents.fixProblems", async () => {
      await provider?.openChat();
      const problems = await buildProblemsContext();
      await provider?.addSelection(
        `Please fix these workspace errors:\n\n${problems}\n\n`,
      );
    }),
    vscode.commands.registerCommand("clawagents.explainSelection", async () => {
      const wrapped = wrapSelectionBlock();
      if (!wrapped) {
        void vscode.window.showInformationMessage("Select code to explain.");
        return;
      }
      await provider?.openChat();
      await provider?.addSelection(`Explain this code:\n\n${wrapped}`);
    }),
    vscode.commands.registerCommand("clawagents.cancel", async () => {
      await provider?.cancelTask();
    }),
    vscode.commands.registerCommand("clawagents.restartSidecar", async () => {
      await provider?.restartSidecar();
    }),
    vscode.commands.registerCommand("clawagents.selectWorkspaceRoot", async () => {
      const roots = workspaceRoots();
      if (roots.length <= 1) {
        void vscode.window.showInformationMessage(
          roots.length === 1
            ? `ClawAgents workspace: ${roots[0].name}`
            : "Open a workspace folder before selecting a ClawAgents root.",
        );
        return;
      }
      if (provider?.busy) {
        void vscode.window.showWarningMessage(
          "Finish or cancel the current ClawAgents task before switching workspace roots.",
        );
        return;
      }
      const current = workspaceRoot();
      const pick = await vscode.window.showQuickPick(
        roots.map((root) => ({
          label: root.name,
          description: root.path,
          root: root.path,
          picked: root.path === current,
        })),
        { title: "Select ClawAgents workspace root", placeHolder: current },
      );
      if (!pick || !setPreferredWorkspaceRoot(pick.root)) {
        return;
      }
      await context.workspaceState.update("clawagents.preferredWorkspaceRoot", pick.root);
      await provider?.restartSidecar();
      await provider?.newChat();
      void vscode.window.showInformationMessage(`ClawAgents root: ${pick.label}`);
    }),
    vscode.commands.registerCommand("clawagents.installPythonDeps", async () => {
      const manager = sidecar;
      if (!manager) {
        return;
      }
      const out = manager.output;
      out.show(true);
      const python = await manager.resolvePythonRuntime();
      out.appendLine(`Installing into ${python}: ${SIDECAR_PIP_PACKAGES.join(" ")}`);
      const probe = await ensureSidecarDeps(python, out, undefined, {
        syncPathFloor: config.pythonRuntime === "custom",
      });
      if (probe.ok) {
        void vscode.window.showInformationMessage(
          `ClawAgents deps OK (${probe.version || "ok"}). Restarting sidecar…`,
        );
        await provider?.restartSidecar();
      } else {
        void vscode.window.showErrorMessage(probe.detail.split("\n")[0] || "Install failed");
      }
    }),
    vscode.commands.registerCommand("clawagents.doctorPython", async () => {
      const manager = sidecar;
      if (!manager) {
        return;
      }
      const out = manager.output;
      out.show(true);
      const python = await manager.resolvePythonRuntime();
      out.appendLine("=== ClawAgents Doctor (Python versions) ===");
      const probe = await ensureSidecarDeps(python, out, undefined, {
        syncPathFloor: config.pythonRuntime === "custom",
      });
      out.appendLine(
        `Sidecar interpreter: ${python}\n` +
          `  version=${probe.version || "?"} ok=${probe.ok}\n` +
          `  executable=${probe.executable || "?"}`,
      );
      out.appendLine("=== Companions ===");
      for (const c of probeCompanions()) {
        out.appendLine(`  ${c.name}: ${c.detail}`);
      }
      if (config.pythonRuntime === "managed") {
        out.appendLine("PATH drift: not applicable (managed environment is isolated).");
        void vscode.window.showInformationMessage(
          `ClawAgents doctor OK — managed sidecar ${probe.version || "?"} @ ${python}`,
        );
        return;
      }
      const remaining = probePathInterpreterDrift(python);
      if (remaining.length === 0) {
        out.appendLine("PATH drift: none (no outdated clawagents on other PATH Pythons).");
        void vscode.window.showInformationMessage(
          `ClawAgents doctor OK — sidecar ${probe.version || "?"} @ ${python}`,
        );
      } else {
        for (const hit of remaining) {
          out.appendLine(
            `PATH drift remaining: ${hit.executable} → clawagents ${hit.version}`,
          );
        }
        void vscode.window.showWarningMessage(
          formatDriftWarning(remaining, python),
          "Dismiss",
        );
      }
    }),
    vscode.commands.registerCommand("clawagents.ensureCompanions", async () => {
      const out = sidecar?.output;
      if (!out) {
        return;
      }
      out.show(true);
      const results = await ensureCompanions(out, {
        force: true,
        python: config.pythonPath,
      });
      const ok = results.every((r) => r.ok);
      if (ok) {
        void vscode.window.showInformationMessage(
          `Companions OK — ${results.map((r) => `${r.name} ${r.version || "?"}`).join(", ")}`,
        );
      } else {
        void vscode.window.showWarningMessage(
          "Some companions are still missing or below floor — see ClawAgents Sidecar output.",
        );
      }
    }),
    vscode.commands.registerCommand("clawagents.graphifyExtract", async () => {
      await runGraphifyWorkspaceCommand(config, sidecar, "extract");
    }),
    vscode.commands.registerCommand("clawagents.graphifyUpdate", async () => {
      await runGraphifyWorkspaceCommand(config, sidecar, "update");
    }),
    vscode.commands.registerCommand("clawagents.graphifyAppendAgentsMd", async () => {
      await appendGraphifyAgentsBlock();
    }),
    vscode.commands.registerCommand("clawagents.setApiKey", async () => {
      const saved = await config.promptSetApiKey();
      if (saved) {
        sidecar?.stop();
        await provider?.restartSidecar();
      }
    }),
    vscode.commands.registerCommand("clawagents.clearApiKey", async () => {
      const cleared = await config.promptClearApiKey();
      if (cleared) {
        sidecar?.stop();
        await provider?.restartSidecar();
      }
    }),
  );

  const sidecarSettings = [
    "clawagents.pythonPath",
    "clawagents.pythonRuntime",
    "clawagents.model",
    "clawagents.provider",
    "clawagents.contextMode",
    "clawagents.graphify",
  ];
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!sidecarSettings.some((k) => e.affectsConfiguration(k))) {
        return;
      }
      if (!sidecar?.current) {
        return;
      }
      if (provider?.busy) {
        void vscode.window.showInformationMessage(
          "ClawAgents: settings saved — they apply after the current task (or Restart Sidecar).",
        );
        return;
      }
      await provider?.restartSidecar();
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      provider?.dispose();
      sidecar?.dispose();
      sidecar = undefined;
      provider = undefined;
    },
  });

  // Optional: focus sidebar on startup (off by default).
  const revealOnStartup = vscode.workspace
    .getConfiguration("clawagents")
    .get<boolean>("revealOnStartup", false);
  if (revealOnStartup) {
    void provider?.openChat();
  }

  // Optional PATH Python floor sync — off by default; never mutates other
  // interpreters without an explicit setting + confirmation.
  void (async () => {
    try {
      const sync = vscode.workspace
        .getConfiguration("clawagents")
        .get<boolean>("syncPathPythons", false);
      if (!sync) {
        return;
      }
      const python = config.pythonPath;
      const drift = probePathInterpreterDrift(python);
      if (drift.length === 0) {
        return;
      }
      const key = `clawagents.pathDriftSynced.${MIN_CLAWAGENTS_VERSION_STR}`;
      if (context.workspaceState.get(key) === true) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `ClawAgents found ${drift.length} PATH Python(s) below ${MIN_CLAWAGENTS_VERSION_STR}. Upgrade them now?`,
        { modal: true },
        "Upgrade PATH Pythons",
        "Skip",
      );
      if (choice !== "Upgrade PATH Pythons") {
        return;
      }
      await context.workspaceState.update(key, true);
      const out = sidecar?.output;
      if (!out) {
        return;
      }
      out.appendLine("Activation: syncing PATH Python clawagents floor (user confirmed)…");
      const result = await ensurePathPythonFloor(python, out);
      if (result.failed.length > 0) {
        void vscode.window.showWarningMessage(
          formatDriftWarning(result.failed, python),
          "Doctor…",
          "Dismiss",
        ).then((pick) => {
          if (pick === "Doctor…") {
            void vscode.commands.executeCommand("clawagents.doctorPython");
          }
        });
      } else if (result.upgraded > 0) {
        void vscode.window.showInformationMessage(
          `ClawAgents: upgraded clawagents on ${result.upgraded} PATH Python(s).`,
        );
      }
    } catch {
      /* probe best-effort */
    }
  })();
}

export function deactivate(): void {
  sidecar?.dispose();
  sidecar = undefined;
}
