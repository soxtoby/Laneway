# Releasing

Laneway is distributed as a Windows installer that updates itself from GitHub Releases ([ADR-0029](adr/0029-distribute-a-windows-installer-that-updates-from-github-releases.md)).

Each release's notes are in `CHANGELOG.md`. Changes not yet released are listed under `## Unreleased`, grouped under these headings, which choose the next version:

- `### Breaking`: something people relied on stops working or has to be done differently, such as a removed feature or settings that don't carry over. Major, or minor below 1.0.
- `### Added`: a new feature, command, or setting. Minor, or patch below 1.0.
- `### Changed`: a deliberate change to how something already works. Minor, or patch below 1.0.
- `### Fixed`: a bug fix. Patch.

While Laneway is in alpha, versions end in `-alpha.<n>`, such as `0.1.0-alpha.2`, and each release counts the alpha up, whatever changed. Installed alphas also update to the first version without it, such as `0.1.0`, which ends the alpha.

To release a version:

1. On a clean worktree, run `bun run prepare-release`. It sets `version` in `desktop/package.json` and moves the Unreleased notes under that version's heading. `bun run prepare-release 0.1.0` sets a version of your choosing instead, such as to end the alpha.
2. Commit, tag the commit with the version, and push the tag: `git tag v0.1.0-alpha.2 && git push origin v0.1.0-alpha.2`.

The Release workflow (`.github/workflows/release.yml`) builds on Windows and publishes `Laneway-Setup-<version>.exe` and `latest.yml`, which names the newest version and the installer's checksum, as the tag's GitHub release, described by the version's notes from `CHANGELOG.md`. Installed copies read `latest.yml` when they next start, or within the hour, download the whole installer, and offer Restart to update.

`bun run package` builds the same installer into `desktop/dist/` without publishing it. `desktop/dist/win-unpacked/Laneway.exe` runs the packaged app without installing it.

People installing Laneway need Git 2.41 or newer. The installer is unsigned, so Windows SmartScreen warns about it until they choose More info, then Run anyway.
