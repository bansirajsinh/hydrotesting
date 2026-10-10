require('dotenv').config();
const config = require('../src/config');
const { connectDatabase, closeDatabase } = require('../src/db');
const { seedDemoData, resetDemoData } = require('../src/seed');

(async () => {
  try {
    if (!config.demoMode) throw new Error('Refusing to seed because DEMO_MODE is not true.');
    const db = await connectDatabase();
    let result;
    if (process.argv.includes('--reset')) {
      if (!config.allowDemoReset) throw new Error('Reset refused. Set ALLOW_DEMO_RESET=true intentionally in .env.');
      result = await resetDemoData(db);
    } else {
      result = await seedDemoData(db);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closeDatabase().catch(() => {});
  }
})();
