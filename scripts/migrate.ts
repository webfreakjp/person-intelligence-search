import { createDriver } from '../packages/db/driver.ts';
import { runMigrations } from '../packages/db/migrate.ts';

const driver = await createDriver();
try {
  await runMigrations(driver);
  console.log('migrations applied');
} finally {
  await driver.close();
}
