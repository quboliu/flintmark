import type { VaultData } from "./protocol";

export function copyVaultData(value: VaultData): VaultData {
  return { notes: [...value.notes], tags: [...value.tags] };
}
