// The in-process test client: runner-free (no vitest), so the bun entry and
// the Vitest helpers share it — as do the createPgTest types, so nothing
// runner-free reaches vitest, not even through its types.

import type { SandboxHooks } from './sandbox'

export interface AppLike {
  /** Hono's `app.request` may answer synchronously, so accept either shape —
   * every caller here awaits the result. */
  request(input: string, init?: RequestInit): Response | Promise<Response>
}

export class TestApiError extends Error {
  status: number
  type: string
  fields?: Record<string, string>
  constructor(status: number, type: string, message: string, fields?: Record<string, string>) {
    super(`${status} ${type}: ${message}`)
    this.status = status
    this.type = type
    this.fields = fields
  }
}

export interface TestClient {
  /** The `row_id` of the user this client is authenticated as (null =
   * anonymous). */
  user: string | null
  token: string | null
  fetch(path: string, init?: RequestInit): Promise<Response>
  get<T = Record<string, unknown>>(path: string): Promise<T>
  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T>
  put<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T>
  delete<T = Record<string, unknown>>(path: string): Promise<T>
}

export function makeClient(app: AppLike, token: string | null, user: string | null): TestClient {
  async function doFetch(path: string, init: RequestInit = {}): Promise<Response> {
    // FormData bodies must keep their runtime-generated multipart boundary —
    // never force a JSON content-type onto them.
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
    return await app.request(path, {
      ...init,
      headers: {
        ...(isForm ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    })
  }
  async function doJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(path, init)
    const body = (await res.json().catch(() => ({}))) as {
      error?: { type: string; message: string; fields?: Record<string, string> }
    }
    if (!res.ok)
      throw new TestApiError(
        res.status,
        body.error?.type ?? 'InternalError',
        body.error?.message ?? `request failed (${res.status})`,
        body.error?.fields,
      )
    return body as T
  }
  return {
    user,
    token,
    fetch: doFetch,
    get: (path) => doJson(path),
    post: (path, body) => doJson(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    put: (path, body) => doJson(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
    delete: (path) => doJson(path, { method: 'DELETE' }),
  }
}

/** A consumer-supplied seeding strategy. `db` is the sandbox transaction;
 * `admin()` lazily builds the administrator client (needs `mintToken`). */
export type SeedCallback = (
  table: string,
  values: Record<string, unknown>,
  ctx: { db: unknown; api: TestClient; admin: () => Promise<TestClient> },
) => Promise<Record<string, unknown> & { row_id: string }>

/** The 0.2 default: POST /api/save_row as the administrator. */
export const saveRowSeed: SeedCallback = async (table, values, { admin }) =>
  (await (await admin()).post('/api/save_row', { table, row: values })) as Record<string, unknown> & {
    row_id: string
  }

export interface PgTestBindings extends SandboxHooks {
  app: AppLike
  /** Mint a session token for an existing enabled user (no password needed —
   * bind to the server's issueSession). Needed by `admin`, `client` and
   * `createUser`; harnesses without auth can leave it out. */
  mintToken?(user: string): Promise<string>
  /** Create a user through the real save lifecycle; returns its `row_id`.
   * Called inside the sandbox, so it rolls back with the test. Needed by
   * `client` and `createUser`. */
  insertUser?(opts: { email: string; fullName?: string; roles: string[] }): Promise<string>
  /** How `seed(table, values)` inserts a row. Default (0.2 behaviour): POST
   * `/api/save_row` as the administrator — featherbase's save endpoint. */
  seed?: SeedCallback
  /** The administrator account name. Default: 'Administrator'. */
  adminUser?: string
}

export type SeedFn = (
  table: string,
  values?: Record<string, unknown>,
) => Promise<Record<string, unknown> & { row_id: string }>


export type CreateUserFn = (opts?: {
  email?: string
  fullName?: string
  roles?: string[]
}) => Promise<TestClient>

export interface PgTestFixtures {
  /** The sandbox transaction handle — raw SQL access inside the test tx. */
  db: unknown
  /** Anonymous in-process client. */
  api: TestClient
  /** Administrator-authenticated client. */
  admin: TestClient
  /** A fresh regular user (created inside the sandbox) with the harness's
   * default roles. */
  client: TestClient
  /** Insert a row through the real save lifecycle as Administrator. */
  seed: SeedFn
  /** Create an additional user; returns an authenticated client. */
  createUser: CreateUserFn
}

export interface PgTestOptions {
  /** Roles granted to `client` / `createUser()` users by default. */
  defaultRoles?: string[]
}
