import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { engineTxContract } from '../contract/engine-tx.contract'

engineTxContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
