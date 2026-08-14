# @snowsalt/dsh-manager

ComfyUI-Manager-style plugin marketplace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Download and use — no special build needed.** Install as a standard dsh profile plugin, then open the marketplace page to browse, install, update, and remove dsh plugins from a community registry plus a live npm search.

## Features

- **Plugin marketplace**: browse installable dsh plugins (official + npm search + community registry).
- **One-click install / uninstall / update** via the `dsh plugin` CLI.
- **Community registry** (ComfyUI-style): a hosted JSON index that anyone can extend by PR.
- **Live npm search**: discovers `@deepseek-ai/dsh-*` and `dsh-plugin`-tagged packages automatically.
- **Standalone page**: served by the harness webserver at `/dsh-manager` — works in any browser.

## Install

```bash
# 1. Add the plugin to the web profile
dsh plugin --profile web add @snowsalt/dsh-manager

# 2. Start the harness web UI
dsh web

# 3. Open the marketplace
#    http://127.0.0.1:3080/dsh-manager
```

For a pre-release / git source:

```bash
dsh plugin --profile web add git+https://github.com/KYZHXL/dsh-manager.git
```

## How it works

The bundle patch (`cordis.patch.yml`) inserts a host plugin that registers
HTTP routes on the harness webserver:

| Route | Purpose |
|---|---|
| `GET /dsh-manager` | The standalone marketplace page (self-contained HTML/JS). |
| `GET /api/dsh-manager/snapshot` | Merged catalog: npm search + community registry + installed state. |
| `POST /api/dsh-manager/install` | `dsh plugin add <source>` for one entry. |
| `POST /api/dsh-manager/uninstall` | `dsh plugin remove <source>`. |
| `POST /api/dsh-manager/update` | `dsh plugin update` all. |

It depends only on `@deepseek-ai/cordis` and `@deepseek-ai/dsh-host-webserver`
(peer dependencies), so it works on any stock DeepSeek Harness.

## Community registry

The default registry is hosted at
[`KYZHXL/dsh-plugin-registry`](https://github.com/KYZHXL/dsh-plugin-registry)
(`plugins.json`). To add your plugin, open a PR adding one entry:

```json
{
  "id": "my-plugin",
  "title": "My Plugin",
  "author": "You",
  "description": "What it does.",
  "source": "git+https://github.com/you/my-plugin.git",
  "reference": "https://github.com/you/my-plugin"
}
```

`source` may be an npm package name or a pnpm-installable git URL.

## Development

```bash
npm install
npm run build     # tsc + copy market.html into lib/web
npm pack          # build the installable tarball
```

## License

MIT
