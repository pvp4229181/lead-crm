// Standalone entry point: `npm run seed:automation -w server`.
// Cleans up the previous automation/template system and seeds the ARIA pack, without
// touching users, leads, contacts, conversations or any other CRM data.
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { migrateToAriaAutomation, printMigrationReport } from './migrate.js';

async function main() {
  await connectDatabase();
  printMigrationReport(await migrateToAriaAutomation());
  await mongoose.disconnect();
}

main().catch(error => { console.error(error); process.exit(1); });
