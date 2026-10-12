# Third-party notices

The researcher and writer agent instructions and research, write, and organize
skill instructions, including their reference manuals, adapt portions of the
Orkas built-in DeepResearcher, ContentWriter, deep-research, content-writer,
and material-organizer materials.

The Node implementations of research budgets, evidence compression, academic
search, citation verification/report assembly, writing evidence coverage, and
editorial preflight adapt the algorithms and rules from these six Orkas Python
scripts. They use OpenHarness tools and direct data inputs; the original Python
runner and Orkas environment-variable interface are not required or included.

Original source paths in Orkas:

- `resources/builtin/marketplace/agents/78900d8758bc/agent.json`
- `resources/builtin/marketplace/agents/173d4235a431/agent.json`
- `resources/builtin/marketplace/skills/ee99fbb42964/`
- `resources/builtin/marketplace/skills/9dfbd4e00c0d/`
- `resources/builtin/marketplace/skills/9be6fda271a5/`

Adapted executable algorithms:

- `resources/builtin/marketplace/skills/ee99fbb42964/scripts/caps.py`
- `resources/builtin/marketplace/skills/ee99fbb42964/scripts/compress.py`
- `resources/builtin/marketplace/skills/ee99fbb42964/scripts/academic.py`
- `resources/builtin/marketplace/skills/ee99fbb42964/scripts/citations.py`
- `resources/builtin/marketplace/skills/9dfbd4e00c0d/scripts/research_gate.py`
- `resources/builtin/marketplace/skills/9dfbd4e00c0d/scripts/audit_content.py`

The adaptations also use the source-quality, evidence, research-workflow,
research-and-evidence, editorial-quality, and audit-and-delivery rules in the
corresponding skills' `references/` directories. Signed source snapshots,
trusted public-key verification, snapshot references, and the OpenHarness
installation/permission integration are OpenHarness-specific.

## Orkas — MIT License

Copyright (c) 2026 Orkas contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
