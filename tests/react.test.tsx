// The /react entry point: the fetch bridge, renderApp's real router + query
// client, and renderSession's Session bound to the rendered page.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import {
  Outlet,
  createRootRoute,
  createRoute,
} from '@tanstack/react-router'
import type { AppLike } from '../src/server'
import { installFetchBridge, renderApp, renderSession } from '../src/react'

afterEach(cleanup)

/** A stand-in for the app under test. `request` answers SYNCHRONOUSLY, the way
 * Hono's does — AppLike accepts `Response | Promise<Response>` precisely so a
 * consumer does not have to wrap it. */
const app: AppLike = {
  request(input: string) {
    if (input.startsWith('/api/rows'))
      return new Response(JSON.stringify({ rows: [{ row_id: 'HDT-00001' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    return new Response('not found', { status: 404 })
  },
}

function Rows() {
  const { data } = useQuery({
    queryKey: ['rows'],
    queryFn: async () => {
      const res = await fetch('/api/rows')
      return (await res.json()) as { rows: { row_id: string }[] }
    },
  })
  return (
    <div>
      <h1>Rows</h1>
      {data?.rows.map((r) => <p key={r.row_id}>{r.row_id}</p>)}
      <p>stored: {localStorage.getItem('fc_user') ?? '(none)'}</p>
    </div>
  )
}

const rootRoute = createRootRoute({ component: () => <Outlet /> })
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <h1>Home</h1> }),
  createRoute({ getParentRoute: () => rootRoute, path: '/rows', component: Rows }),
])

describe('installFetchBridge', () => {
  it('dispatches app-relative requests in-process and restores the original fetch', async () => {
    const original = globalThis.fetch
    const restore = installFetchBridge(app)
    expect(globalThis.fetch).not.toBe(original)

    const res = await fetch('/api/rows')
    expect(await res.json()).toEqual({ rows: [{ row_id: 'HDT-00001' }] })

    restore()
    expect(globalThis.fetch).toBe(original)
  })

  it('leaves unbridged paths to the original fetch', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('elsewhere')
    }) as typeof fetch
    const restore = installFetchBridge(app)

    await fetch('https://example.test/thing')
    expect(calls).toEqual(['https://example.test/thing'])

    restore()
    globalThis.fetch = original
  })
})

describe('renderApp', () => {
  it('mounts the route tree at the requested path', async () => {
    const restore = installFetchBridge(app)
    const { session } = await renderSession('/rows', {
      routeTree,
      token: 'tok',
      user: { row_id: 'agent@feather.test' },
    })
    await session.assertText('HDT-00001')
    restore()
  })

  it('stores the session for the app to read, keying the user by row_id', async () => {
    localStorage.clear()
    await renderApp('/', {
      routeTree,
      token: 'tok',
      user: { row_id: 'agent@feather.test' },
    })
    expect(localStorage.getItem('fc_token')).toBe('tok')
    expect(JSON.parse(localStorage.getItem('fc_user')!)).toEqual({
      row_id: 'agent@feather.test',
      email: 'agent@feather.test',
      full_name: null,
    })
  })

  it('lets the caller override the stored profile', async () => {
    localStorage.clear()
    await renderApp('/', {
      routeTree,
      token: 'tok',
      user: { row_id: 'agent@feather.test', email: 'other@feather.test', full_name: 'Agent' },
    })
    expect(JSON.parse(localStorage.getItem('fc_user')!)).toEqual({
      row_id: 'agent@feather.test',
      email: 'other@feather.test',
      full_name: 'Agent',
    })
  })

  it('writes nothing without a token', async () => {
    localStorage.clear()
    await renderApp('/', { routeTree, user: { row_id: 'agent@feather.test' } })
    expect(localStorage.getItem('fc_user')).toBeNull()
  })
})

describe('renderSession', () => {
  it('scopes the session to the rendered page', async () => {
    const restore = installFetchBridge(app)
    const { session, queryClient, router } = await renderSession('/rows', {
      routeTree,
      token: 'tok',
      user: { row_id: 'agent@feather.test' },
    })
    expect(queryClient).toBeDefined()
    expect(router).toBeDefined()
    await session.assertText('Rows').assertText('HDT-00001')
    restore()
  })
})
