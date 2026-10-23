# Third-party notices

OfficeCLI v1.0.139 — iOfficeAI/OfficeCLI. Apache License 2.0; full text in licenses/OFFICECLI-LICENSE. Platform release binaries are distributed unmodified. Pinned SHA-256 values for Windows, macOS and Linux (x64 and arm64) are maintained in packages/services/src/office/office-engine.mjs and copied into the plugin at build time. The universal marketplace archive includes all six binaries; installation and normal execution require no binary download or global OfficeCLI installation. Upstream source: https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.139 .

The ASCII-only JSON transport workaround and safe working-copy approach are adapted from Orkas, commit eb5dde92cf397db57831d34a23823bc0b458d1bb (MIT). Copyright (c) 2026 Orkas contributors. Full license in licenses/ORKAS-LICENSE. This plugin is an independent, scoped PPTX/DOCX/XLSX integration; it does not include the Orkas application or its Electron renderer.

Official skills under vendor/officecli/skills (officecli, officecli-docx, officecli-pptx, officecli-xlsx) are vendored verbatim from the same v1.0.139 tag, under Apache-2.0. They are loaded directly; application execution guidance lives in agents and tool descriptions. No global skill installation is performed.

The upstream skills/officecli/SKILL.md is a symbolic link to ../../SKILL.md. This distribution materializes the unmodified root SKILL.md body at that entry path so loading works without symbolic-link resolution. SOURCE.json records the original link target and blob hash as well as the materialized body source path and hashes. The three format skills remain unchanged.
