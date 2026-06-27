# bioclaw-env

Bundled sandbox Python for BioClaw Desktop's skill runner. Same
pyproject + uv.lock both Desktop and CI use. Mirrors the OmicOS
`omicos-env` model:

* Top-level deps are the BASE set — every install gets them.
* Extras (`scientific`, `single-cell`, `local-llm`, `phylo`, `gpu`)
  are opt-in at setup time. The SetupWizard surfaces them as
  checkboxes; CLI users pass `--extra <name>` to `bioclaw env setup`.

## Reproducing locally

```bash
cd bioclaw-env
uv sync                           # base env
uv sync --extra scientific        # adds numpy/pandas/scipy/matplotlib
uv sync --extra scientific --extra single-cell
```

After `uv sync`, the materialised venv lives at `bioclaw-env/.venv/`.
The desktop installer ships the **source** (`pyproject.toml`, `uv.lock`,
`README.md`) plus a bundled `_base/` Python interpreter; the venv
itself is materialised on first run by `bioclaw env setup`, populated
into `~/.bioclaw/env/.venv` (not under the install dir — same as
OmicOS).
