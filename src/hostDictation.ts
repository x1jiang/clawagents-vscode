/**
 * Mic picker + OS dictation:
 * - macOS: pick input device (CoreAudio) → Edit → Start Dictation… (Fn Fn)
 * - Windows: pick input when possible → Win+H voice typing
 *
 * Webview mic is blocked; OS dictation types into the focused field.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type DictationTarget = "composer" | "bug_report";

export type AudioInputDevice = {
  id: string;
  label: string;
  isDefault: boolean;
};

const STATE_LAST_MIC = "clawagents.lastDictationMicId";

function whichSync(bin: string): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which";
  const pathAugment =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(":")
      : process.env.PATH;
  const result = spawnSync(cmd, [bin], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PATH: pathAugment },
  });
  if (result.status === 0) {
    const hit = (result.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (hit) return hit;
  }
  if (process.platform === "darwin") {
    for (const p of [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function runOsascript(script: string): { ok: boolean; detail: string } {
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 12_000,
    env: process.env,
  });
  if (result.status === 0) {
    return { ok: true, detail: (result.stdout || "").trim() };
  }
  const err = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return { ok: false, detail: err || `osascript exit ${result.status}` };
}

function startAppleDictation(): { ok: boolean; detail: string } {
  const script = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  click menu item "Start Dictation…" of menu "Edit" of menu bar 1 of frontApp
end tell
`;
  return runOsascript(script);
}

function stopAppleDictation(): void {
  runOsascript(`
tell application "System Events"
  key code 53
end tell
`);
}

function startWindowsVoiceTyping(): { ok: boolean; detail: string } {
  // Win+H — Windows voice typing (comparable to Apple Dictation / Fn Fn).
  const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ClawAgentsKeybd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const byte VK_LWIN = 0x5B;
  public const byte VK_H = 0x48;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@
[ClawAgentsKeybd]::keybd_event([ClawAgentsKeybd]::VK_LWIN, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[ClawAgentsKeybd]::keybd_event([ClawAgentsKeybd]::VK_H, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[ClawAgentsKeybd]::keybd_event([ClawAgentsKeybd]::VK_H, 0, [ClawAgentsKeybd]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
[ClawAgentsKeybd]::keybd_event([ClawAgentsKeybd]::VK_LWIN, 0, [ClawAgentsKeybd]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 15_000, env: process.env },
  );
  if (result.status === 0) {
    return { ok: true, detail: "Win+H" };
  }
  const err = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return { ok: false, detail: err || `powershell exit ${result.status}` };
}

function stopWindowsVoiceTyping(): void {
  // Esc dismisses the voice typing UI.
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')`,
    ],
    { encoding: "utf8", timeout: 8_000, env: process.env },
  );
}

function macScriptPath(extensionPath: string): string {
  return path.join(extensionPath, "scripts", "mac_audio_input.swift");
}

/** Prefer VSIX-bundled binary (no Xcode CLT / brew). */
function macAudioCli(extensionPath: string): { cmd: string; prefix: string[] } | undefined {
  const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const candidates = [
    path.join(extensionPath, "bin", "darwin-universal", "mac_audio_input"),
    path.join(extensionPath, "bin", arch, "mac_audio_input"),
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      try {
        fs.accessSync(bin, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(bin, 0o755);
        } catch {
          /* ignore */
        }
      }
      return { cmd: bin, prefix: [] };
    }
  }
  // Optional brew fallback (no Xcode needed).
  const switchAudio = whichSync("SwitchAudioSource");
  if (switchAudio) {
    return { cmd: switchAudio, prefix: ["__switchaudio__"] };
  }
  // Last resort: compile-on-the-fly via swift (needs Xcode CLT).
  const script = macScriptPath(extensionPath);
  const swift = whichSync("swift");
  if (swift && fs.existsSync(script)) {
    return { cmd: swift, prefix: [script] };
  }
  return undefined;
}

function parseMacListOutput(stdout: string): AudioInputDevice[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, isDef, ...rest] = line.split("\t");
      return {
        id,
        isDefault: isDef === "1",
        label: rest.join("\t") || id,
      };
    })
    .filter((d) => Boolean(d.id));
}

function listViaSwitchAudioSource(bin: string): AudioInputDevice[] {
  const list = spawnSync(bin, ["-a", "-t", "input"], {
    encoding: "utf8",
    timeout: 8_000,
    env: process.env,
  });
  const current = spawnSync(bin, ["-c", "-t", "input"], {
    encoding: "utf8",
    timeout: 8_000,
    env: process.env,
  });
  const currentName = (current.stdout || "").trim();
  if (list.status !== 0) {
    return [];
  }
  return (list.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({
      id: name,
      label: name,
      isDefault: name === currentName,
    }));
}

function listMacInputs(extensionPath: string): AudioInputDevice[] {
  const cli = macAudioCli(extensionPath);
  if (!cli) {
    return [];
  }
  if (cli.prefix[0] === "__switchaudio__") {
    return listViaSwitchAudioSource(cli.cmd);
  }
  const result = spawnSync(cli.cmd, [...cli.prefix, "list"], {
    encoding: "utf8",
    timeout: 20_000,
    env: process.env,
  });
  if (result.status !== 0) {
    return [];
  }
  return parseMacListOutput(result.stdout || "");
}

function setMacInput(extensionPath: string, id: string): boolean {
  const cli = macAudioCli(extensionPath);
  if (!cli) {
    return false;
  }
  if (cli.prefix[0] === "__switchaudio__") {
    const result = spawnSync(cli.cmd, ["-t", "input", "-s", id], {
      encoding: "utf8",
      timeout: 8_000,
      env: process.env,
    });
    return result.status === 0;
  }
  const result = spawnSync(cli.cmd, [...cli.prefix, "set", id], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
  return result.status === 0;
}

function listWindowsInputsFfmpeg(): AudioInputDevice[] {
  const ffmpeg = whichSync("ffmpeg");
  if (!ffmpeg) {
    return [];
  }
  const result = spawnSync(
    ffmpeg,
    ["-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8", timeout: 12_000, env: process.env },
  );
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  const devices: AudioInputDevice[] = [];
  let inAudio = false;
  for (const line of text.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (inAudio && /DirectShow video devices/i.test(line)) {
      break;
    }
    if (!inAudio) continue;
    const m = line.match(/"([^"]+)"/);
    if (m) {
      devices.push({ id: m[1], label: m[1], isDefault: devices.length === 0 });
    }
  }
  return devices;
}

function listWindowsInputsCmdlets(): AudioInputDevice[] {
  const ps = `
$ErrorActionPreference = 'Stop'
try {
  Import-Module AudioDeviceCmdlets -ErrorAction Stop
  Get-AudioDevice -List | Where-Object { $_.Type -eq 'Recording' } | ForEach-Object {
    $def = if ($_.Default) { '1' } else { '0' }
    Write-Output ("{0}\t{1}\t{2}" -f $_.Index, $def, $_.Name)
  }
} catch {
  exit 3
}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 20_000, env: process.env },
  );
  if (result.status !== 0) {
    return [];
  }
  return (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, isDef, ...rest] = line.split("\t");
      return {
        id,
        isDefault: isDef === "1",
        label: rest.join("\t") || id,
      };
    })
    .filter((d) => Boolean(d.id));
}

function setWindowsInputCmdlets(index: string): boolean {
  const ps = `
$ErrorActionPreference = 'Stop'
Import-Module AudioDeviceCmdlets -ErrorAction Stop
Set-AudioDevice -Index ${Number(index)}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 15_000, env: process.env },
  );
  return result.status === 0;
}

async function pickInputDevice(
  devices: AudioInputDevice[],
  lastId: string | undefined,
  platform: NodeJS.Platform,
): Promise<AudioInputDevice | "settings" | undefined> {
  type Item = vscode.QuickPickItem & {
    device?: AudioInputDevice;
    openSettings?: boolean;
  };

  const items: Item[] = devices.map((d) => {
    const reused = lastId && d.id === lastId;
    const desc = [
      d.isDefault ? "system default" : undefined,
      reused ? "last used" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      label: d.label,
      description: desc || undefined,
      device: d,
    };
  });

  if (items.length === 0) {
    items.push({
      label: "Use current system default microphone",
      description: "No device list available",
      device: { id: "", label: "System default", isDefault: true },
    });
  }

  if (platform === "win32") {
    items.push({
      label: "$(settings-gear) Open Windows Sound input settings…",
      description: "Pick the mic in Settings, then run Mic again",
      openSettings: true,
    });
  } else if (platform === "darwin") {
    items.push({
      label: "$(settings-gear) Open macOS Sound settings…",
      description: "System Settings → Sound → Input",
      openSettings: true,
    });
  }

  const active = items.find(
    (i) => i.device && (i.device.id === lastId || i.device.isDefault),
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "ClawAgents: choose microphone",
    placeHolder: "Dictate with this mic (Apple Dictation / Windows voice typing)",
    matchOnDescription: true,
    ignoreFocusOut: true,
  });

  if (!picked) {
    return undefined;
  }
  if (picked.openSettings) {
    return "settings";
  }
  // Prefer last-used when user dismisses oddly — active is only for default highlight;
  // QuickPick doesn't set activeItems on show in all versions, so we sort last used first.
  void active;
  return picked.device;
}

function openSoundSettings(platform: NodeJS.Platform): void {
  if (platform === "darwin") {
    spawnSync("open", ["x-apple.systempreferences:com.apple.Sound-Settings.extension"], {
      timeout: 5_000,
    });
    // Fallback for older macOS:
    spawnSync("open", ["/System/Library/PreferencePanes/Sound.prefPane"], {
      timeout: 5_000,
    });
  } else if (platform === "win32") {
    spawnSync("cmd.exe", ["/c", "start", "ms-settings:sound"], {
      timeout: 5_000,
      shell: false,
    });
  }
}

export class HostDictation {
  private listening = false;
  private target: DictationTarget = "composer";
  private extensionPath = "";
  private globalState: vscode.Memento | undefined;

  configure(extensionPath: string, globalState: vscode.Memento): void {
    this.extensionPath = extensionPath;
    this.globalState = globalState;
  }

  get recording(): boolean {
    return this.listening;
  }

  get activeTarget(): DictationTarget {
    return this.target;
  }

  async toggle(
    _config: unknown,
    output: { appendLine(s: string): void },
    target: DictationTarget = "composer",
    onBeforeStart?: () => Promise<void>,
  ): Promise<
    | { kind: "started"; target: DictationTarget; detail?: string }
    | { kind: "stopped"; target: DictationTarget }
    | { kind: "cancelled"; target: DictationTarget }
    | { kind: "error"; target: DictationTarget; detail: string }
  > {
    if (this.listening) {
      if (process.platform === "win32") {
        stopWindowsVoiceTyping();
      } else {
        stopAppleDictation();
      }
      this.listening = false;
      output.appendLine("Dictation: stopped");
      return { kind: "stopped", target: this.target };
    }

    if (vscode.env.remoteName) {
      return {
        kind: "error",
        target,
        detail:
          "Dictation needs a local window (mic is on your machine). Open the folder locally.",
      };
    }

    if (process.platform !== "darwin" && process.platform !== "win32") {
      return {
        kind: "error",
        target,
        detail:
          "Mic dictation supports macOS (Apple Dictation) and Windows (Win+H voice typing).",
      };
    }

    this.target = target;
    const lastId = this.globalState?.get<string>(STATE_LAST_MIC);

    let devices: AudioInputDevice[] = [];
    if (process.platform === "darwin") {
      if (!this.extensionPath) {
        return {
          kind: "error",
          target,
          detail: "Dictation not configured (missing extension path).",
        };
      }
      devices = listMacInputs(this.extensionPath);
      if (devices.length === 0) {
        output.appendLine(
          "Dictation: no mac mic list (bundled bin/darwin-*/mac_audio_input missing?). Using system default.",
        );
      }
    } else {
      devices = listWindowsInputsCmdlets();
      if (devices.length === 0) {
        devices = listWindowsInputsFfmpeg();
        if (devices.length === 0) {
          output.appendLine(
            "Dictation: no Windows mic list (optional: Install-Module AudioDeviceCmdlets, or brew/choco ffmpeg).",
          );
        }
      }
    }

    // Put last-used / default near the top for fast Enter.
    devices = [...devices].sort((a, b) => {
      const score = (d: AudioInputDevice) =>
        (lastId && d.id === lastId ? 2 : 0) + (d.isDefault ? 1 : 0);
      return score(b) - score(a);
    });

    const picked = await pickInputDevice(devices, lastId, process.platform);
    if (!picked) {
      return { kind: "cancelled", target };
    }
    if (picked === "settings") {
      openSoundSettings(process.platform);
      return {
        kind: "error",
        target,
        detail:
          "Opened sound settings — choose your mic, then click Mic again to dictate.",
      };
    }

    if (picked.id) {
      let setOk = true;
      if (process.platform === "darwin") {
        setOk = setMacInput(this.extensionPath, picked.id);
      } else {
        // Cmdlets use numeric index; ffmpeg names cannot be set without the module.
        if (/^\d+$/.test(picked.id)) {
          setOk = setWindowsInputCmdlets(picked.id);
          if (!setOk) {
            output.appendLine(
              `Dictation: could not set Windows mic index ${picked.id} (AudioDeviceCmdlets?). Using system default.`,
            );
          }
        } else {
          output.appendLine(
            `Dictation: listed "${picked.label}" via ffmpeg — set it as default in Sound settings if needed (Install-Module AudioDeviceCmdlets for one-click switch).`,
          );
        }
      }
      if (process.platform === "darwin" && !setOk) {
        return {
          kind: "error",
          target,
          detail: `Could not switch mic to “${picked.label}”. Check mic permissions, then try again.`,
        };
      }
      await this.globalState?.update(STATE_LAST_MIC, picked.id);
      output.appendLine(`Dictation: mic → ${picked.label} (${picked.id || "default"})`);
    }

    // QuickPick steals focus — caller re-focuses the webview textarea first.
    if (onBeforeStart) {
      await onBeforeStart();
    } else {
      await new Promise((r) => setTimeout(r, 180));
    }

    if (process.platform === "darwin") {
      const started = startAppleDictation();
      if (!started.ok) {
        const detail = /not allowed|1002|1743|assistive|Accessibility/i.test(
          started.detail,
        )
          ? "Allow Accessibility for Cursor/VS Code (Privacy & Security → Accessibility), then try Mic again. Or focus the box and press Fn Fn."
          : `Could not start Apple Dictation: ${started.detail.slice(0, 200)}. Focus the composer and press Fn Fn.`;
        output.appendLine(`Dictation failed: ${started.detail}`);
        return { kind: "error", target, detail };
      }
      this.listening = true;
      const detail = `Apple Dictation · ${picked.label}`;
      void vscode.window.showInformationMessage(
        `ClawAgents: ${detail} — speak into the box. Mic / Esc / Fn Fn to stop.`,
      );
      return { kind: "started", target, detail };
    }

    const started = startWindowsVoiceTyping();
    if (!started.ok) {
      return {
        kind: "error",
        target,
        detail: `Could not start Windows voice typing (Win+H): ${started.detail.slice(0, 200)}. Focus the box and press Win+H.`,
      };
    }
    this.listening = true;
    const detail = `Windows voice typing · ${picked.label}`;
    void vscode.window.showInformationMessage(
      `ClawAgents: ${detail} — speak into the box. Mic / Esc / Win+H to stop.`,
    );
    return { kind: "started", target, detail };
  }

  async cancel(): Promise<void> {
    if (!this.listening) return;
    if (process.platform === "win32") {
      stopWindowsVoiceTyping();
    } else {
      stopAppleDictation();
    }
    this.listening = false;
  }
}

export const hostDictation = new HostDictation();
