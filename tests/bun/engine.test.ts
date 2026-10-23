import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { engineCloneContract } from '../contract/engine-clone.contract'
import { engineTxContract } from '../contract/engine-tx.contract'

engineTxContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
engineCloneContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
