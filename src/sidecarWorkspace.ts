import * as fs from "fs";
import * as path from "path";

/** Copy retained state without overwriting newer files or following symlinks. */
function importMissingFiles(source: string, destination: string): void {
  if (!fs.existsSync(source) || !fs.lstatSync(source).isDirectory()) return;
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      // An existing symlink must not redirect writes outside the storage root.
      if (!fs.existsSync(to) || fs.lstatSync(to).isDirectory()) importMissingFiles(from, to);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}

/** Empty windows need a host-local workspace that survives extension upgrades. */
export function resolveSidecarWorkspace(
  workspace: string | undefined,
  storagePath: string,
  extensionPath: string,
  output?: { appendLine(line: string): void },
): string {
  if (workspace) return workspace;
  const root = path.join(storagePath, "no-folder-workspace");
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, ".legacy-state-imported");
  if (!fs.existsSync(marker)) {
    const extensions = path.dirname(extensionPath);
    const retained = fs.readdirSync(extensions, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^clawagents\.clawagents-\d+\.\d+\.\d+(?:-[\w-]+)?$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of retained) {
      importMissingFiles(path.join(extensions, name, ".clawagents"), path.join(root, ".clawagents"));
    }
    // Import once: later startups must not resurrect chats the user deleted.
    try {
      fs.writeFileSync(marker, "Legacy no-folder state imported.\n", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    output?.appendLine(`No-folder chat state recovered into ${root}. Legacy files retained.`);
  }
  return root;
}
