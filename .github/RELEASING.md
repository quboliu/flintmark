# Releasing Flintmark

Flintmark publishes tagged releases to GitHub and the VS Code Marketplace. The
Marketplace connection uses Microsoft Entra workload identity federation:
GitHub issues a short-lived OIDC token, Azure exchanges it for the
`flintmark-marketplace-publisher` managed identity, and `vsce` publishes with
`--azure-credential`. No Personal Access Token or client secret is stored.

## One-time Microsoft Entra setup

1. In the [Azure portal](https://portal.azure.com/), create a resource group and
   a **user-assigned managed identity** named
   `flintmark-marketplace-publisher`. Grant it the **Reader** role on that
   resource group.
2. Open the managed identity's **Federated credentials** page and add a
   credential using the **GitHub Actions deploying Azure resources** scenario:

   - Organization: `quboliu`
   - Repository: `flintmark`
   - Entity type: `Environment`
   - GitHub environment name: `marketplace`
   - Credential name: `flintmark-github-marketplace`

   The generated subject must be
   `repo:quboliu/flintmark:environment:marketplace`; the audience is
   `api://AzureADTokenExchange`.
3. Record the managed identity's **Client ID**, **Tenant ID**, and Azure
   **Subscription ID**.

Microsoft documents the managed-identity federation flow in
[Create trust between a user-assigned managed identity and an external identity provider](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity).

## One-time GitHub setup

1. In the repository, open **Settings -> Environments** and create an environment
   named `marketplace`. Configure its deployment branches and tags so that only
   the `main` branch and tags matching `v*` are allowed.
2. Add these environment secrets. They are identifiers, not reusable
   credentials, but environment scope prevents unrelated jobs from reading
   them:

   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
3. Run **Actions -> Marketplace auth check -> Run workflow**. The first run
   prints a notice named **Marketplace identity ID**. Copy that GUID.
4. Open the [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage/publishers/quboliu),
   add that identity ID as a member of publisher `quboliu`, and give it the
   **Contributor** role.
5. Re-run **Marketplace auth check**. It is ready when
   `vsce verify-pat quboliu --azure-credential` succeeds.

The GitHub environment is intentional: it gives every tag and manual run the
same OIDC subject. Microsoft Entra federated credentials do not support wildcard
subjects, so binding directly to version tags would require a new credential for
every release.

## Cut a release

1. Update the version in both `package.json` and `package-lock.json`.
2. Add the matching `## X.Y.Z` entry at the top of `CHANGELOG.md`.
3. Run the release gate:

   ```sh
   npm run lint
   npx tsc --noEmit -p .
   npm run test:unit
   npx @vscode/vsce package
   ```

4. Commit and push the release changes, then tag that exact commit:

   ```sh
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

The `Release` workflow verifies that the tag matches `package.json`, rebuilds a
clean VSIX, validates its contents, authenticates through OIDC, checks publisher
access, creates the GitHub Release, and publishes the same VSIX to the VS Code
Marketplace. Publishing uses `--skip-duplicate`, so a failed workflow can be
safely re-run after correcting an external configuration problem.

Do not create a release tag until **Marketplace auth check** passes.
