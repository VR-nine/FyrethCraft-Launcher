# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Fixed update button not working in settings - added missing imports (isDev, ipcRenderer, shell, remote, Lang) in settings.js
- Version is now dynamically displayed from package.json instead of hardcoded values in HTML templates

## [0.1.4] - 2026-01-12

### Fixed
- Fixed game launch issue on macOS due to missing native LWJGL libraries
- Added support for automatic updates on macOS via ZIP files
- Improved native library path handling for all platforms

## [0.1.3] - 2026-01-09

### Added
- Initial launcher version

[Unreleased]: https://github.com/VR-nine/FyrethCraft-Launcher/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/VR-nine/FyrethCraft-Launcher/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/VR-nine/FyrethCraft-Launcher/releases/tag/v0.1.3
