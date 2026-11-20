# Publishing ClawAgents for VS Code

- **Publisher:** `clawagents`
- **Current version:** `1.0.217`
- **Required Python core:** `clawagents>=6.20.102,<7`
- **Release history:** See [CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/x1jiang/clawagents-vscode/releases).

## Release Checklist

1. Ensure `clawagents_py` is published on PyPI if `MIN_CLAWAGENTS_VERSION` in `src/pythonDeps.ts` / `python/requirements.txt` is bumped.
2. Bump the version consistently across:
   - `package.json` (`"version"`)
   - `package-lock.json` (root + `packages[""]`)
   - `CHANGELOG.md` (promote `# Unreleased` to `# X.Y.Z`)
   - `PUBLISH.md` (header above)
3. Build, test, and package:
   ```bash
   npm run install:all
   npm run build
   npm test
   cd python && PYTHONPATH=. python3 -m pytest -q && cd ..
   npm run package   # produces clawagents-X.Y.Z.vsix
   ```
4. Commit, tag, and push:
   ```bash
   git add package.json package-lock.json CHANGELOG.md PUBLISH.md
   git commit -m "Release vX.Y.Z: <summary>"
   git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"
   git push origin main
   git push origin vX.Y.Z
   ```
5. Publish the GitHub Release with the `.vsix` attached:
   ```bash
   gh release create vX.Y.Z --repo x1jiang/clawagents-vscode \
     --title "vX.Y.Z" \
     --notes "<release highlights>" \
     ./clawagents-X.Y.Z.vsix
   ```

## Marketplace & Open VSX Publishing

Visual Studio Marketplace and Open VSX publishing require separate PAT credentials (`VSCE_PAT` / `OVSX_PAT`), which are never committed to the repository.

### Automated (GitHub Actions)

Configure `VSCE_PAT` (and optionally `OVSX_PAT`) under **Repository Settings → Secrets and variables → Actions**. Pushing any `v*` tag triggers the `publish-marketplace` job in [.github/workflows/ci.yml](.github/workflows/ci.yml) after the `release-gate` job passes.

### Manual CLI

```bash
# Visual Studio Marketplace
VSCE_PAT='...' npx --yes @vscode/vsce@4.1.0 publish --packagePath ./clawagents-X.Y.Z.vsix

# Open VSX Registry (Cursor / VSCodium)
OVSX_PAT='...' npx --yes ovsx@0.10.1 publish ./clawagents-X.Y.Z.vsix -p "$OVSX_PAT"
```

Alternatively, upload `clawagents-X.Y.Z.vsix` directly in the Visual Studio Marketplace Publisher Management portal.
