import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
    try {
        console.log('Running migrations...');
        await migrate(db, { migrationsFolder: path.join(__dirname, 'drizzle') });
        console.log('Migrations completed successfully!');
        process.exit(0);
    } catch (err) {
        console.error('Error running migrations:', err);
        process.exit(1);
    }
}

runMigrations();
