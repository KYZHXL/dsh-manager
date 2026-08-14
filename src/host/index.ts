/**
 * dsh-manager host plugin.
 *
 * Registers `/api/dsh-manager/*` routes on the harness webserver, providing the
 * plugin marketplace: a merged catalog (official + live npm search + community
 * registry JSON) plus install / uninstall / update via the `dsh plugin` CLI.
 *
 * This is fully self-contained — it depends only on the webserver service and
 * Node built-ins, so it works on any DeepSeek Harness without a special build.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The bundled market page (self-contained HTML; served at /dsh-manager/). */
const MARKET_HTML_PATH = fileURLToPath(new URL('../web/market.html', import.meta.url))

/** The webserver route-registration service provided by the harness. */
interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerService
  }
}
/** Cordis plugin name. */
export const name = 'dsh-manager-host'

/** Services this plugin needs before mounting. */
export const inject = ['webServer']

/** npm registry search endpoints, primary then CN mirror fallback. */
const NPM_SEARCH_URLS = [
  'https://registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin%20OR%20scope:deepseek-ai&size=100',
  'https://registry.npmmirror.com/-/v1/search?text=keywords:dsh-plugin%20OR%20scope:deepseek-ai&size=100',
]

/** Remote community registry JSON, GitHub raw then jsDelivr mirror. */
const REMOTE_REGISTRY_URLS = [
  'https://raw.githubusercontent.com/KYZHXL/dsh-plugin-registry/main/plugins.json',
  'https://cdn.jsdelivr.net/gh/KYZHXL/dsh-plugin-registry@main/plugins.json',
]

/** Fetch timeout in milliseconds. */
const FETCH_TIMEOUT_MS = 20_000

/** The dsh web profile directory (where `dsh plugin` manages packages). */
function profileDir(): string {
  return join(homedir(), '.dsh', 'profiles', 'web')
}

/** Read the installed bundles/dependencies from the profile manifest. */
async function readInstalled(): Promise<{ name: string; bundle: boolean }[]> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    return Object.keys(manifest.dependencies ?? {}).map(name => ({ name, bundle: bundles.has(name) }))
  } catch {
    return []
  }
}

/** Run one `dsh plugin` command in the profile. */
function runPlugin(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('pnpm', ['dsh', 'plugin', '--profile', 'web', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${process.env.PATH ?? ''};${process.env.APPDATA ?? ''}\\npm` },
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32',
    }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve()
    })
  })
}

/** Search npm for dsh plugins, with mirror fallback. */
async function searchNpm(): Promise<{ name: string; version: string; description?: string; author?: string; reference?: string }[]> {
  for (const url of NPM_SEARCH_URLS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) continue
      const data = await response.json() as { objects?: { package: { name: string; version: string; description?: string; author?: { name?: string } | string; links?: { repository?: string } } }[] }
      const entries: { name: string; version: string; description?: string; author?: string; reference?: string }[] = []
      for (const obj of data.objects ?? []) {
        const pkg = obj.package
        if (/dsh-(base|web-app|headless|bundle)$/.test(pkg.name)) continue
        const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
        entries.push({
          name: pkg.name,
          version: pkg.version,
          ...pkg.description !== undefined ? { description: pkg.description } : {},
          ...author !== undefined ? { author } : {},
          ...pkg.links?.repository !== undefined ? { reference: pkg.links.repository } : {},
        })
      }
      return entries
    } catch {
      // fall through to mirror
    } finally {
      clearTimeout(timer)
    }
  }
  return []
}

/** Fetch the community registry JSON, with mirror fallback. */
async function fetchRegistry(): Promise<{ id: string; title?: string; author?: string; description?: string; source: string; reference?: string }[]> {
  for (const url of REMOTE_REGISTRY_URLS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) continue
      const data = await response.json() as { plugins?: unknown[] }
      const entries: { id: string; title?: string; author?: string; description?: string; source: string; reference?: string }[] = []
      for (const row of data.plugins ?? []) {
        const r = row as { id?: string; title?: string; author?: string; description?: string; source?: string; reference?: string }
        if (typeof r.id !== 'string' || typeof r.source !== 'string') continue
        entries.push({ id: r.id, ...r.title !== undefined ? { title: r.title } : {}, ...r.author !== undefined ? { author: r.author } : {}, ...r.description !== undefined ? { description: r.description } : {}, source: r.source, ...r.reference !== undefined ? { reference: r.reference } : {} })
      }
      return entries
    } catch {
      // fall through to mirror
    } finally {
      clearTimeout(timer)
    }
  }
  return []
}

/** Merge the catalog sources into one market list. */
async function buildMarket(): Promise<{ market: Record<string, unknown>[]; warnings: string[] }> {
  const warnings: string[] = []
  const [npm, registry, installed] = await Promise.all([searchNpm(), fetchRegistry(), readInstalled()])
  const installedNames = new Set(installed.map(row => row.name))
  const seen = new Set<string>()
  const market: Record<string, unknown>[] = []
  const push = (id: string, entry: Record<string, unknown>): void => {
    if (seen.has(id)) return
    seen.add(id)
    market.push({ ...entry, installed: installedNames.has(id) })
  }
  for (const pkg of npm) {
    push(pkg.name, {
      id: pkg.name,
      title: pkg.name.split('/').pop() ?? pkg.name,
      ...pkg.author !== undefined ? { author: pkg.author } : {},
      ...pkg.description !== undefined ? { description: pkg.description } : {},
      source: pkg.name,
      installType: 'npm',
      sourceOf: 'npm',
      ...pkg.reference !== undefined ? { reference: pkg.reference } : {},
      version: pkg.version,
    })
  }
  for (const row of registry) {
    push(row.id, {
      id: row.id,
      title: row.title ?? row.id,
      ...row.author !== undefined ? { author: row.author } : {},
      ...row.description !== undefined ? { description: row.description } : {},
      source: row.source,
      installType: /^git\+|\.git(?:$|#)|^github:/.test(row.source) ? 'git' : 'npm',
      sourceOf: 'registry',
      ...row.reference !== undefined ? { reference: row.reference } : {},
    })
  }
  return { market, warnings }
}

/** Send a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

/** Parse the request body as JSON. */
async function readJson<T>(req: import('node:http').IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

/**
 * Register the manager's routes on the webserver.
 * @param ctx - plugin context with the webserver service.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.webServer
  // The standalone market page, served at /dsh-manager/. It talks to the API
  // routes below via fetch, so it works from any browser.
  webServer.register({ kind: 'exact', path: '/dsh-manager', handler: async (_req, res) => {
    try {
      const html = await readFile(MARKET_HTML_PATH, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
      res.end(html)
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) })
    }
  } })

  webServer.register({ kind: 'exact', path: '/api/dsh-manager/snapshot', handler: async (_req, res) => {
    try {
      const { market, warnings } = await buildMarket()
      json(res, 200, { ok: true, market, warnings })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) })
    }
  } })

  webServer.register({ kind: 'exact', path: '/api/dsh-manager/install', handler: async (req, res) => {
    try {
      const { id } = await readJson<{ id?: string }>(req)
      const { market } = await buildMarket()
      const entry = market.find(row => row.id === id)
      if (entry === undefined) { json(res, 404, { ok: false, error: `unknown plugin ${String(id)}` }); return }
      const spec = typeof entry.source === 'string' ? entry.source : ''
      await runPlugin(['add', spec])
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) })
    }
  } })

  webServer.register({ kind: 'exact', path: '/api/dsh-manager/uninstall', handler: async (req, res) => {
    try {
      const { id } = await readJson<{ id?: string }>(req)
      const { market } = await buildMarket()
      const entry = market.find(row => row.id === id)
      if (entry === undefined) { json(res, 404, { ok: false, error: `unknown plugin ${String(id)}` }); return }
      const spec = typeof entry.source === 'string' ? entry.source : ''
      await runPlugin(['remove', spec])
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) })
    }
  } })

  webServer.register({ kind: 'exact', path: '/api/dsh-manager/update', handler: async (_req, res) => {
    try {
      await runPlugin(['update'])
      json(res, 200, { ok: true })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error) })
    }
  } })
}

/** Cordis loads function plugins through the module's default export. */
export default { name, inject, apply }
