# Releasing

Laneway is distributed as a Windows installer that updates itself from GitHub Releases ([ADR-0029](adr/0029-distribute-a-windows-installer-that-updates-from-github-releases.md)).

To release a version:

1. Set `version` in `desktop/package.json` and commit it. While Laneway is in alpha, versions end in `-alpha.<n>`, such as `0.1.0-alpha.2`. Installed alphas also update to the first version without it, such as `0.1.0`, which ends the alpha.
2. Tag that commit with the same version and push the tag: `git tag v0.1.0-alpha.2 && git push origin v0.1.0-alpha.2`.

The Release workflow (`.github/workflows/release.yml`) builds on Windows and publishes `Laneway-Setup-<version>.exe` and `latest.yml`, which names the newest version and the installer's checksum, as the tag's GitHub release. Installed copies read `latest.yml` when they next start, or within the hour, download the whole installer, and offer Restart to update.

`bun run package` builds the same installer into `desktop/dist/` without publishing it. `desktop/dist/win-unpacked/Laneway.exe` runs the packaged app without installing it.

People installing Laneway need Git 2.41 or newer. The installer is unsigned, so Windows SmartScreen warns about it until they choose More info, then Run anyway.
