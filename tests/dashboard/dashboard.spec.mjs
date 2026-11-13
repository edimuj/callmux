import { test as base, expect } from '@playwright/test'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createListener } from '../../dist/library.js'

const token = 'dashboard-smoke-local-token'
const test = base.extend({
  app: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'callmux-browser-'))
    let listener
    let proxy
    const sockets = new Set()
    const upstreamRequests = new Set()
    let offline = false
    const paths = []
    try {
      listener = await createListener({
        host: '127.0.0.1', port: 0,
        configPath: join(dir, 'config.json'),
        config: {
          servers: { smoke: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./upstream.mjs', import.meta.url))],
          } },
          dashboard: { enabled: true },
          management: {
            enabled: true, statePath: join(dir, 'overlay.json'),
            auth: { mode: 'bearer', tokens: [{ id: 'smoke', token }] },
          },
        },
      })
      // A real streaming reverse proxy: strip an optional external mount, and
      // sever existing SSE connections when simulating a network outage.
      proxy = createServer((req, res) => {
        paths.push(req.url)
        if (offline) { res.writeHead(503).end(); return }
        const path = req.url.replace(/^\/operations(?=\/)/, '')
        const forwarded = request(new URL(path, listener.url), {
          method: req.method, headers: { ...req.headers, host: new URL(listener.url).host },
        }, (response) => {
          res.writeHead(response.statusCode, response.headers)
          response.pipe(res)
        })
        upstreamRequests.add(forwarded)
        forwarded.on('close', () => upstreamRequests.delete(forwarded))
        forwarded.on('error', () => res.destroy())
        res.on('close', () => forwarded.destroy())
        req.pipe(forwarded)
      })
      proxy.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      await use({
        url: `http://127.0.0.1:${proxy.address().port}`,
        listenerUrl: listener.url,
        paths,
        statePath: join(dir, 'overlay.json'),
        setOffline(value) {
          offline = value
          if (value) for (const socket of sockets) socket.destroy()
        },
      })
    } finally {
      for (const socket of sockets) socket.destroy()
      for (const forwarded of upstreamRequests) forwarded.destroy()
      if (proxy) await new Promise((resolve) => proxy.close(resolve))
      await listener?.stop()
      await rm(dir, { recursive: true, force: true })
    }
  },
})

for (const prefix of ['', '/operations']) {
  test(`embedded dashboard loads servers, tools and manages a server at ${prefix || '/'}`, async ({ page, app }) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const response = await page.goto(`${app.url}${prefix}/dashboard`)
    expect(response.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Dashboard sections' })
    await nav.getByRole('button', { name: 'Servers', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: 'smoke' })).toContainText('connected')
    await nav.getByRole('button', { name: 'Tool Suites', exact: true }).click()
    await expect(page.getByText('smoke_echo', { exact: true })).toBeVisible()
    await nav.getByRole('button', { name: 'Management', exact: true }).click()
    await page.getByLabel('Management token', { exact: true }).fill(token)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('button', { name: 'Disable', exact: true }).click()
    await expect(page.getByText('Disable completed for smoke.', { exact: true })).toBeVisible()
    const row = page.getByRole('row').filter({ hasText: 'smoke' })
    await expect(row).toContainText('disabled')
    await expect(row.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
    const overlay = JSON.parse(await readFile(app.statePath, 'utf8'))
    expect(overlay.servers.smoke.config.disabled).toBe(true)
    expect(app.paths).toContain(`${prefix}/dashboard/data`)
    expect(app.paths).toContain(`${prefix}/dashboard/events`)
    expect(app.paths).toContain(`${prefix}/management/v1/servers/smoke`)
    if (prefix) expect(app.paths.every((path) => path.startsWith(prefix + '/'))).toBe(true)
    expect(errors).toEqual([])
  })
}

test('recovers live data after connection loss without a page reload', async ({ page, app }) => {
  await page.goto(`${app.url}/dashboard`)
  const health = page.locator('aside')
  await expect(health.getByText(/^Live ·/)).toBeVisible()
  await expect.poll(() => app.paths.includes('/dashboard/events')).toBe(true)
  app.setOffline(true)
  await expect(health.getByText('Disconnected', { exact: true })).toBeVisible()
  // Change real backend state while the browser cannot receive its events.
  const changed = await fetch(`${app.listenerUrl}/management/v1/servers/smoke`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  })
  expect(changed.status).toBe(200)
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/dashboard/data') && response.status() === 200)
  app.setOffline(false)
  await refreshed
  await expect(health.getByText(/^Live ·/)).toBeVisible()
  await page.getByRole('navigation', { name: 'Dashboard sections' }).getByRole('button', { name: 'Management' }).click()
  await expect(page.getByRole('row').filter({ hasText: 'smoke' })).toContainText('disabled')
})
