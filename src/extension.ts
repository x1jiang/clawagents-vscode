import * as vscode from "vscode";
import {
  buildProblemsContext,
  ExtensionConfig,
  trackEditorFocus,
  wrapCurrentFileRef,
  wrapSelectionBlock,
} from "./config";
import { ensureCompanions, probeCompanions } from "./companionDeps";
import { ensureSidecarDeps, SIDECAR_PIP_PACKAGES } from "./pythonDeps";
import {
  formatDriftWarning,
  probePathInterpreterDrift,
} from "./pythonPathPin";
import { SidecarManager } from "./sidecar";
import { ClawAgentsWebviewProvider } from "./webviewProvider";

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
  sidecar = new SidecarManager(context.extensionPath, config);
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
    vscode.commands.registerCommand("clawagents.installPythonDeps", async () => {
      const out = sidecar?.output;
      if (!out) {
        return;
      }
      out.show(true);
      const python = config.pythonPath;
      out.appendLine(`Installing into ${python}: ${SIDECAR_PIP_PACKAGES.join(" ")}`);
      const probe = await ensureSidecarDeps(python, out);
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
      const out = sidecar?.output;
      if (!out) {
        return;
      }
      out.show(true);
      const python = config.pythonPath;
      out.appendLine("=== ClawAgents Doctor (Python versions) ===");
      const probe = await ensureSidecarDeps(python, out);
      out.appendLine(
        `Sidecar interpreter: ${python}\n` +
          `  version=${probe.version || "?"} ok=${probe.ok}\n` +
          `  executable=${probe.executable || "?"}`,
      );
      out.appendLine("=== Companions ===");
      for (const c of probeCompanions()) {
        out.appendLine(`  ${c.name}: ${c.detail}`);
      }
      const drift = probePathInterpreterDrift(python);
      if (drift.length === 0) {
        out.appendLine("PATH drift: none (no outdated clawagents on other PATH Pythons).");
        void vscode.window.showInformationMessage(
          `ClawAgents doctor OK — sidecar ${probe.version || "?"} @ ${python}`,
        );
      } else {
        for (const hit of drift) {
          out.appendLine(`PATH drift: ${hit.executable} → clawagents ${hit.version}`);
          out.appendLine(
            `  Fix: "${hit.executable}" -m pip install -U ${SIDECAR_PIP_PACKAGES[0]}`,
          );
        }
        const choice = await vscode.window.showWarningMessage(
          formatDriftWarning(drift, python),
          "Upgrade PATH Pythons",
          "Install Sidecar Deps",
          "Dismiss",
        );
        if (choice === "Upgrade PATH Pythons") {
          for (const hit of drift) {
            out.appendLine(`Upgrading ${hit.executable}…`);
            const upgraded = await ensureSidecarDeps(hit.executable, out);
            out.appendLine(
              `  → ok=${upgraded.ok} version=${upgraded.version || "?"}`,
            );
          }
          void vscode.window.showInformationMessage(
            "PATH Python upgrades finished — check ClawAgents Sidecar output.",
          );
        } else if (choice === "Install Sidecar Deps") {
          await vscode.commands.executeCommand("clawagents.installPythonDeps");
        }
      }
    }),
    vscode.commands.registerCommand("clawagents.ensureCompanions", async () => {
      const out = sidecar?.output;
      if (!out) {
        return;
      }
      out.show(true);
      const results = await ensureCompanions(out, { force: true });
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
    "clawagents.model",
    "clawagents.provider",
    "clawagents.contextMode",
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

  // Warn once per window when PATH has outdated clawagents (common macOS
  // Homebrew/conda vs clawagents.pythonPath mismatch).
  void (async () => {
    try {
      const python = config.pythonPath;
      const drift = probePathInterpreterDrift(python);
      if (drift.length === 0) {
        return;
      }
      const key = "clawagents.pathDriftWarned";
      if (context.workspaceState.get(key) === true) {
        return;
      }
      await context.workspaceState.update(key, true);
      const choice = await vscode.window.showWarningMessage(
        formatDriftWarning(drift, python),
        "Doctor…",
        "Dismiss",
      );
      if (choice === "Doctor…") {
        await vscode.commands.executeCommand("clawagents.doctorPython");
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
