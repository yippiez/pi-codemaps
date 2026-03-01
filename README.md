# pi-codemaps

`pi-codemaps` is a Pi package that adds codemap commands:

- `/codemap:create <prompt>` creates a codemap JSON file in `.pi/codemaps/`
- `/codemap:list` opens an interactive list to view, open, and refresh saved codemaps

## Install from Git

Global install (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/yippiez/pi-codemaps
```

Local/project install (writes to `.pi/settings.json` in the current repo):

```bash
pi install -l git:github.com/yippiez/pi-codemaps
```

## Optional: Pin to a ref

Pin global install to `main`:

```bash
pi install git:github.com/yippiez/pi-codemaps@main
```

Pin local install to `main`:

```bash
pi install -l git:github.com/yippiez/pi-codemaps@main
```
