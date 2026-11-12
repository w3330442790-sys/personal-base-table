import type { Vault } from "obsidian";
import { SnapshotStore, type SnapshotLimits } from "../core/snapshots";

/** Use the Vault adapter so hidden history files work on desktop and mobile. */
export class ObsidianSnapshots extends SnapshotStore {
  constructor(vault: Vault, limits?: SnapshotLimits) {
    super(vault.adapter, limits);
  }
}
