import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { engineCloneContract, templateNamesContract } from '../contract/engine-clone.contract'
import { engineTxContract, nowFrozenContract } from '../contract/engine-tx.contract'

engineTxContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
engineCloneContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { factoryContract } from '../contract/factory.contract'
factoryContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
nowFrozenContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { oneTestAtATimeContract } from '../contract/one-test-at-a-time.contract'
oneTestAtATimeContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { failedStartContract } from '../contract/failed-start.contract'
failedStartContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { abandonedDatabasesContract } from '../contract/abandoned-databases.contract'
abandonedDatabasesContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
templateNamesContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
