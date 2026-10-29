# Releasing Flintmark

Flintmark is a VS Code extension. The Release workflow is the supported public
release pipeline and builds the VSIX from a clean tagged checkout.

## One-time PAT setup

1. Sign in to [Azure DevOps](https://dev.azure.com/) with the Microsoft account
   that manages publisher `quboliu`. If the account has no Azure DevOps
   organization, create one first; the organization only provides access to the
   PAT settings page.
2. Open **User settings -> Personal access tokens -> New Token**. Configure:

   - Name: `flintmark-github-marketplace`
   - Organization: **All accessible organizations**
   - Expiration: choose a date and record it for rotation
   - Scopes: **Custom defined -> Show all scopes -> Marketplace -> Manage**

3. Copy the PAT when it is displayed. Azure DevOps does not show it again.
4. In GitHub, open **Settings -> Environments -> marketplace**. The environment
   must allow only the `main` branch and tags matching `v*`.
5. Add an environment secret named `VSCE_PAT` containing the PAT.
6. Run **Actions -> Marketplace auth check -> Run workflow** on `main`. It is
   ready when `vsce verify-pat quboliu` succeeds.

Never put the PAT in repository variables, workflow YAML, shell history, issue
comments, or release notes. Rotate it before its expiration date.

Microsoft's current PAT instructions and retirement notice are in
[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Cut a release

1. Create a release branch. Update package.json and both root version entries
   in package-lock.json with `npm version X.Y.Z --no-git-tag-version`.
2. Add matching release notes to CHANGELOG.md.
3. Run the release checks inside the development VM:

   ```sh
   npm run check:versions
   npm run lint
   npx tsc --noEmit -p .
   npm run test:unit
   npm run test:perf
   npm run test:integration
   npm run test:e2e
   npx @vscode/vsce package
   ```

4. Push the branch and open a PR. Wait for all CI checks, then merge.
5. Tag the merged release commit and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a vX.Y.Z -m "Flintmark X.Y.Z"
   git push origin vX.Y.Z
   ```

The Release workflow validates the tag and package versions, builds a clean
VSIX, checks its contents, and publishes two assets:

- flintmark-X.Y.Z.vsix — the VS Code extension.
- SHA256SUMS.txt — the VSIX checksum.

Verify the workflow succeeds, the release is public, and both assets download.
When VSCE_PAT is available, the workflow verifies publisher access and publishes
the same VSIX. Without a PAT, Marketplace publishing is explicitly skipped.

Run **Marketplace auth check** before tagging only when automated Marketplace
publishing is expected.

## Manual Marketplace upload

Download the validated VSIX from the GitHub Release and upload it at the
[publisher management page](https://marketplace.visualstudio.com/manage/publishers/quboliu).
Do not substitute a package built from a development working tree.
