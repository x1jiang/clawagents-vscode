import * as vscode from "vscode";
import {
  buildProblemsContext,
  ExtensionConfig,
  trackEditorFocus,
  wrapCurrentFileRef,
  wrapSelectionBlock,
} from "./config";
import { ensureSidecarDeps, SIDECAR_PIP_PACKAGES } from "./pythonDeps";
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

  // First activation: ensure remote/local Python has clawagents + extras.
  // Also runs again from sidecar ensureStarted when imports fail.
  void (async () => {
    const out = vscode.window.createOutputChannel("ClawAgents Sidecar");
    try {
      await ensureSidecarDeps(config.pythonPath, out);
    } catch (err) {
      out.appendLine(err instanceof Error ? err.message : String(err));
    }
  })();

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
      const out = vscode.window.createOutputChannel("ClawAgents Sidecar");
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
}

export function deactivate(): void {
  sidecar?.dispose();
  sidecar = undefined;
}
