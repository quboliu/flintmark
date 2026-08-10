import { existsSync } from "node:fs";

interface VaultBuildGateDependencies {
  exists: (path: string) => boolean;
  wait: () => Promise<void>;
}

const defaultDependencies: VaultBuildGateDependencies = {
  exists: existsSync,
  wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
};

/** Deterministic e2e-only gate. Production has no gate path and returns
 * immediately; tests hold a temp file until editor interactivity is proven. */
export async function waitForVaultBuildGate(
  gatePath: string | undefined,
  dependencies: VaultBuildGateDependencies = defaultDependencies
): Promise<void> {
  if (!gatePath) return;
  while (dependencies.exists(gatePath)) await dependencies.wait();
}
