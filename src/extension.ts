import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import {
  buildProblemsContext,
  ExtensionConfig,
  trackEditorFocus,
  wrapCurrentFileRef,
  wrapSelectionBlock,
} from "./config";
import { SidecarManager } from "./sidecar";
import { ClawAgentsWebviewProvider } from "./webviewProvider";

let sidecar: SidecarManager | undefined;
let provider: ClawAgentsWebviewProvider | undefined;

async function checkPythonDeps(
  context: vscode.ExtensionContext,
  pythonPath: string,
): Promise<void> {
  const stateKey = "clawagents.depsPrompted.v1";
  if (context.globalState.get(stateKey)) {
    return;
  }

  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(
      pythonPath,
      ["-c", "import clawagents, fastapi, uvicorn, pydantic"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 8000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

  if (ok) {
    await context.globalState.update(stateKey, true);
    return;
  }

  const req = path.join(context.extensionPath, "python", "requirements.txt");
  const choice = await vscode.window.showWarningMessage(
    "ClawAgents needs Python packages (clawagents, fastapi, uvicorn). Install them into the interpreter from setting clawagents.pythonPath.",
    "Copy install command",
    "Open settings",
    "Don't show again",
  );
  if (choice === "Copy install command") {
    await vscode.env.clipboard.writeText(
      `${pythonPath} -m pip install -r "${req}" && ${pythonPath} -m pip install 'clawagents[gemini,anthropic,mcp]'`,
    );
    void vscode.window.showInformationMessage("Install command copied to clipboard.");
  } else if (choice === "Open settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "clawagents.pythonPath",
    );
  } else if (choice === "Don't show again") {
    await context.globalState.update(stateKey, true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const config = new ExtensionConfig(context.secrets);
  sidecar = new SidecarManager(context.extensionPath, config);
  provider = new ClawAgentsWebviewProvider(context, sidecar, config);

  trackEditorFocus(context.subscriptions);

  void checkPythonDeps(context, config.pythonPath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ClawAgentsWebviewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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
    vscode.commands.registerCommand("clawagents.setApiKey", async () => {
      const saved = await config.promptSetApiKey();
      if (saved) {
        sidecar?.stop();
        await provider?.restartSidecar();
      }
    }),
  );

  // Apply relevant VS Code setting changes by restarting the sidecar (its
  // environment is fixed at spawn). Skipped while a task is streaming.
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
        return; // not started yet — next start picks the new values up
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
}

export function deactivate(): void {
  sidecar?.dispose();
  sidecar = undefined;
}
