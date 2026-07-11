# Publish checklist (Marketplace)

Do this once the publisher account and PAT are ready.

## Prerequisites

1. Create publisher **`clawagents`** at https://marketplace.visualstudio.com/manage  
   (must match `package.json` → `"publisher"`)
2. Azure DevOps PAT with **Marketplace → Manage**
3. Push this extension source to https://github.com/x1jiang/clawagents  
   (or update `repository` / `bugs` / `homepage` in `package.json` to the real repo)
4. Confirm PyPI `clawagents>=6.10.0` still installs cleanly for end users

## Publish to VS Code Marketplace

```bash
cd clawagents_vscode
npx @vscode/vsce login clawagents   # paste PAT
npm run package                     # builds clawagents-0.5.0.vsix
npm run publish                     # uploads current version
```

Or publish an existing VSIX:

```bash
npx @vscode/vsce publish --packagePath ./clawagents-0.5.0.vsix
```

Listing URL (after indexing):  
https://marketplace.visualstudio.com/items?itemName=clawagents.clawagents

## Publish to Open VSX (Cursor / others)

```bash
# Create token at https://open-vsx.org
npx ovsx publish ./clawagents-0.5.0.vsix -p "$OVSX_PAT"
```

## After publish

- [ ] Install from Marketplace in a clean VS Code profile
- [ ] Confirm first-run Python deps prompt + sidecar start
- [ ] Smoke-test OpenAI / Gemini / Anthropic with Auto-approve off
- [ ] Bump version for every subsequent release (Marketplace rejects duplicates)

## Notes

- Never commit PATs
- Each Marketplace version is immutable — bump `package.json` version for fixes
- Users still need `pip install clawagents…` into `clawagents.pythonPath`
