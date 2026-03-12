import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
    ? new Pool({
        connectionString
    })
    : new Pool({
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'sup_video_call'
    });

export const db = drizzle(pool, { schema });
export default db;

