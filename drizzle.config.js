import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;

export default defineConfig({
    schema: './schema.js',
    out: './drizzle',
    driver: 'pg',
    dbCredentials: connectionString
        ? {
            connectionString
        }
        : {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'password',
            database: process.env.DB_NAME || 'sup_video_call'
        },
    verbose: true,
    strict: true
});
