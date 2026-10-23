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
import { migrateOnceContract } from '../contract/migrate-once.contract'
migrateOnceContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { graceTimeoutContract } from '../contract/grace-timeout.contract'
graceTimeoutContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { rawFacadeContract } from '../contract/raw-facade.contract'
rawFacadeContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { dbClientContract } from '../contract/db-client.contract'
dbClientContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { hiddenClientContract } from '../contract/hidden-client.contract'
hiddenClientContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { databaseSafetyContract } from '../contract/database-safety.contract'
databaseSafetyContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { cloneTeardownContract } from '../contract/clone-teardown.contract'
cloneTeardownContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { clonePoolContract } from '../contract/clone-pool.contract'
clonePoolContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { lostContextContract } from '../contract/lost-context.contract'
lostContextContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { slowQueryContract } from '../contract/slow-query.contract'
slowQueryContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { currentDatabaseContract } from '../contract/current-database.contract'
currentDatabaseContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { searchPathContract } from '../contract/search-path.contract'
searchPathContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { effectiveDatabaseContract } from '../contract/effective-database.contract'
effectiveDatabaseContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
import { dropDatabaseContract } from '../contract/drop-database.contract'
dropDatabaseContract({ describe, test, expect, beforeAll, afterAll, beforeEach, afterEach })
