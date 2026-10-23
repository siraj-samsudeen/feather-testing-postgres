// Dropping a template/clone as a role that isn't a superuser: WITH (FORCE)
// must terminate every session on it, and Postgres refuses (42501) when one
// belongs to another role — typically an autovacuum worker. A plain DROP may
// stop autovacuum itself, so that is the fallback. Pure: runs in every lane.
import { dropDatabase } from '../../src/engine'
import type { SqlRunner } from '../../src/engine'
import type { RunnerApi } from './runner'

function stub(failForce: unknown): { sql: SqlRunner; statements: string[] } {
  const statements: string[] = []
  const sql = (async () => []) as unknown as SqlRunner
  sql.unsafe = async (text: string) => {
    statements.push(text)
    if (failForce && /with \(force\)/.test(text)) throw failForce
    return []
  }
  return { sql, statements }
}

export function dropDatabaseContract({ describe, test, expect }: RunnerApi) {
  describe('dropping a test database', () => {
    test('FORCE first', async () => {
      const { sql, statements } = stub(undefined)
      await dropDatabase(sql, 'feather_t_x')
      expect(statements).toEqual(['drop database if exists "feather_t_x" with (force)'])
    })

    test('refused for permission (not a superuser): a plain DROP instead', async () => {
      const { sql, statements } = stub(Object.assign(new Error('permission denied to terminate process'), { code: '42501' }))
      await dropDatabase(sql, 'feather_t_x')
      expect(statements).toEqual([
        'drop database if exists "feather_t_x" with (force)',
        'drop database if exists "feather_t_x"',
      ])
    })

    test('any other failure is not retried', async () => {
      const { sql } = stub(Object.assign(new Error('something else'), { code: '55006' }))
      await expect(dropDatabase(sql, 'feather_t_x')).rejects.toThrow('something else')
    })
  })
}
