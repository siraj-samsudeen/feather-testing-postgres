// Typecheck-only: the shapes a consumer binds this harness with. It is not a
// vitest file — `npm run typecheck` compiles it, and that is the point. If the
// published types drift from what a real consumer writes, this stops
// compiling here instead of in the consumer's repo.
//
// Every pattern below is lifted from featherbase's bindings
// (apps/server/test/pg-test-shared.ts and apps/web/test/pg-test.ts), including
// the two shapes it used to have to cast around.

import {
  createPgTest,
  makeClient,
  TestApiError,
  withSandbox,
  type AppLike,
  type CreateUserFn,
  type PgTestBindings,
  type PgTestFixtures,
  type PgTestOptions,
  type SandboxHooks,
  type SeedFn,
  type SqlLike,
  type TestClient,
} from '../../src/index'
import {
  installFetchBridge,
  renderApp,
  renderSession,
  Session,
  StepError,
  createSession,
  type RenderAppOptions,
  type RenderAppResult,
  type SessionOptions,
  type SessionRenderResult,
} from '../../src/react'

// A Hono app's request() resolves SYNCHRONOUSLY. No Promise.resolve() wrapper.
declare const honoApp: {
  request(input: string, init?: RequestInit): Response | Promise<Response>
}
const app: AppLike = honoApp

declare const sql: SqlLike
declare function setSqlDelegate(tx: unknown | null): void
declare function issueSession(user: string): Promise<{ token: string }>
declare function saveRow(
  table: string,
  values: Record<string, unknown>,
  as: string,
): Promise<{ row_id: string }>

const hooks: SandboxHooks = { sql, setDelegate: setSqlDelegate }
const bindings: PgTestBindings = {
  ...hooks,
  app,
  mintToken: async (user) => (await issueSession(user)).token,
  // insertUser answers with a row id.
  insertUser: async ({ email, fullName, roles }) => {
    const row = await saveRow(
      'User',
      { row_id: email, email, full_name: fullName, roles: roles.map((role) => ({ role })) },
      'Administrator',
    )
    return String(row.row_id)
  },
}

const options: PgTestOptions = { defaultRoles: ['All'] }
export const test = createPgTest(bindings, options)

export async function usesFixtures(f: PgTestFixtures) {
  const seed: SeedFn = f.seed
  const createUser: CreateUserFn = f.createUser
  const row = await seed('HD Ticket', { subject: 'x' })
  const rowId: string = row.row_id
  const other: TestClient = await createUser({ email: 'a@b.test' })
  const client: TestClient = makeClient(app, other.token, other.user)
  try {
    await client.post('/api/save_row', { table: 'HD Ticket', row: {} })
  } catch (e) {
    if (e instanceof TestApiError) {
      const status: number = e.status
      void status
    }
  }
  await withSandbox(hooks, async () => rowId)
}

// A session user is keyed by row_id.
function sessionUser(as: TestClient): RenderAppOptions['user'] {
  return as.user ? { row_id: as.user } : undefined
}

declare const routeTree: unknown

export async function rendersTheApp(as: TestClient) {
  installFetchBridge(app)
  const rendered: RenderAppResult = await renderApp('/admin/HD Ticket', {
    routeTree,
    token: as.token,
    user: sessionUser(as),
  })
  void rendered.queryClient

  const withSession: SessionRenderResult = await renderSession('/admin/HD Ticket/new', {
    routeTree,
    token: as.token,
    user: sessionUser(as),
    session: { timeout: 5000 } satisfies SessionOptions,
  })

  await withSession.session
    .fillIn('Subject', 'Filed from a component test')
    .fillIn('Quantity', 12)
    .selectOption('Priority', 'High')
    .clickButton('Save')
    .assertText('HDT-')

  const standalone: Session = createSession({ root: withSession.baseElement as HTMLElement })
  await standalone.within('.fc-card', (s) => s.assertText('Subject')).refuteText('No such row')

  try {
    await standalone.clickButton('Save')
  } catch (e) {
    if (e instanceof StepError) void e.message
  }
}
