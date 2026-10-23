// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { engineTxContract } from '../contract/engine-tx.contract'

engineTxContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
