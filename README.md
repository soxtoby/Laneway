# Laneway

Laneway is an opinionated Git client for working on several lines of work at once. Each worktree or branch gets a column showing its stack of branches, its commits, and its working changes, beside a graph that places every branch relative to the one it's based on. From there you reshape your work directly: move changes into earlier commits, edit an old commit in place, pull and restack branches, and publish a whole stack. Every Laneway operation can be undone.

> [!WARNING]
> Laneway is in alpha. Expect rough edges, missing features, and changes between versions. Operations can be undone, but keep anything important pushed somewhere.

## Requirements

- Windows 10 or 11, 64-bit
- [Git](https://git-scm.com/downloads) 2.41 or newer, on `PATH` or chosen in Laneway's settings

## Install

1. Download `Laneway-Setup-<version>.exe` from the [latest release](https://github.com/soxtoby/Laneway/releases/latest).
2. Run it. The installer isn't signed, so Windows SmartScreen may warn that it protected your PC; choose **More info**, then **Run anyway**.

Laneway installs for your Windows account, without administrator rights, and starts. It updates itself: new versions download in the background and install when you quit Laneway, or straight away from **Restart to update**.

## License

[MIT](LICENSE)
