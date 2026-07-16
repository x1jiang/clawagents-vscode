# Publish checklist (Marketplace)

Publisher **`clawagents`** · source https://github.com/x1jiang/clawagents-vscode · version **1.0.46**

For the full **Python + VS Code** release flow (bump, build, tag, GitHub, PyPI), see [`../RELEASE.md`](../RELEASE.md).

## Done already

- [x] Publisher created on Marketplace
- [x] GitHub repo pushed: https://github.com/x1jiang/clawagents-vscode
- [x] `package.json` repository / bugs / homepage point at that repo
- [x] **Publish `clawagents` 6.17.1 to PyPI first** (1.0.46 requires `>=6.17.1`)
- [ ] VSIX built: `clawagents-1.0.46.vsix`

## Publish to VS Code Marketplace

```bash
VSCE_PAT='paste-token-here' npx @vscode/vsce publish --packagePath ./clawagents-1.0.46.vsix
```
