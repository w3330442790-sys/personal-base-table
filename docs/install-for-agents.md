# Install Personal Base Table

This repository distributes the personal Obsidian edition with independent plugin ID `personal-base-table`.

On desktop or Android, install BRAT, choose **Add beta plugin**, enter `w3330442790-sys/personal-base-table`, and select **Latest**. Disable the old Weilanx Base Table so only the personal edition handles .wbase files. Remove `Azure12355/weilanx-base-table` from BRAT tracking if replacing that version.

Manual installation: download main.js, manifest.json, and styles.css from [the personal release](https://github.com/w3330442790-sys/personal-base-table/releases/latest) into <vault>/.obsidian/plugins/personal-base-table/. Keep existing data.json and all workbook files. Do not uninstall to update.

The installer scripts/install.sh --obsidian /path/to/vault downloads the personal edition. Its VS Code mode is inherited upstream functionality; this repository's Obsidian releases do not distribute a VSIX.

The original MIT attribution is retained in LICENSE and README.upstream.md. Upstream attribution links are not update sources for the personal Obsidian edition.
