# Publish checklist (Marketplace)

Publisher **`clawagents`** · source https://github.com/x1jiang/clawagents-vscode · version **1.0.45**

For the full **Python + VS Code** release flow (bump, build, tag, GitHub, PyPI), see [`../RELEASE.md`](../RELEASE.md).

## Done already

- [x] Publisher created on Marketplace
- [x] GitHub repo pushed: https://github.com/x1jiang/clawagents-vscode
- [x] `package.json` repository / bugs / homepage point at that repo
- [x] **Publish `clawagents` 6.17.0 to PyPI first** (1.0.45 requires `>=6.17.0`)
- [x] VSIX built: `clawagents-1.0.45.vsix`

## You still need: Azure DevOps PAT (once)

1. Open https://dev.azure.com → sign in with the **same Microsoft account** used for the Marketplace publisher
2. User settings (top right) → **Personal access tokens** → **New Token**
3. Settings:
   - Organization: **All accessible organizations**
   - Expiration: 90 days (or custom)
   - Scopes: **Custom** → **Marketplace** → check **Manage**
4. Create → **copy the token** (shown once)

## Publish to VS Code Marketplace

From `clawagents_vscode`:

```bash
# Option A — env var (no interactive login store)
VSCE_PAT='paste-token-here' npx @vscode/vsce publish --packagePath ./clawagents-1.0.45.vsix

# Option B — login once, then publish
npx @vscode/vsce login clawagents   # paste PAT when prompted
npm run publish
```

Listing (after indexing, often a few minutes):  
https://marketplace.visualstudio.com/items?itemName=clawagents.clawagents

## Optional: Open VSX (Cursor / others)

1. Create account + token at https://open-vsx.org
2. Namespace must match publisher id (`clawagents`) or claim it
3. Publish:

```bash
npx ovsx publish ./clawagents-1.0.45.vsix -p "$OVSX_PAT"
```
