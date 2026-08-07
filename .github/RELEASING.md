# Releasing Flintmark

Flintmark publishes tagged releases to GitHub and the VS Code Marketplace. The
Marketplace connection currently uses an Azure DevOps Personal Access Token
(PAT) stored in the protected `marketplace` GitHub Environment.

Microsoft retires global Azure DevOps PATs on December 1, 2026. Before that
date, migrate this workflow to Microsoft Entra workload identity federation or
publish the VSIX manually from the Marketplace publisher management page.

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

1. Update the version in both `package.json` and `package-lock.json`.
2. Add the matching `## X.Y.Z` entry at the top of `CHANGELOG.md`.
3. Run the release gate:

   ```sh
   npm run lint
   npx tsc --noEmit -p .
   npm run test:unit
   npm run test:perf
   npx @vscode/vsce package
   ```

4. Commit and push the release changes, then tag that exact commit:

   ```sh
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

The `Release` workflow verifies that the tag matches `package.json`, rebuilds a
clean VSIX, validates its contents, and creates the GitHub Release first. When
`VSCE_PAT` is available it then verifies Marketplace publisher access and
publishes the same VSIX using `--skip-duplicate`. Without a PAT, Marketplace
publishing is explicitly skipped while the GitHub Release remains successful;
use the manual fallback below for that release.

Run **Marketplace auth check** before tagging whenever automated Marketplace
publishing is expected. A failed or unavailable check does not block a
GitHub-only release.

## Manual fallback

If the PAT is unavailable, download the validated VSIX from the GitHub Release
(or run `npx @vscode/vsce package` from a clean checkout) and upload it at the
[publisher management page](https://marketplace.visualstudio.com/manage/publishers/quboliu).
