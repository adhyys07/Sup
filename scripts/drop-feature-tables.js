import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

const pool = connectionString
    ? new Pool({ connectionString })
    : new Pool({
        user: process.env.DB_USER ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'password',
        host: process.env.DB_HOST ?? 'localhost',
        port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
        database: process.env.DB_NAME ?? 'sup_video_call'
    });

const TABLES_SQL = `
DROP TABLE IF EXISTS breakout_room_participants CASCADE;
DROP TABLE IF EXISTS breakout_rooms CASCADE;
DROP TABLE IF EXISTS meeting_reactions CASCADE;
DROP TABLE IF EXISTS meeting_recordings CASCADE;
DROP TABLE IF EXISTS meeting_transcriptions CASCADE;
DROP TABLE IF EXISTS meeting_waiting_room CASCADE;
DROP TABLE IF EXISTS poll_responses CASCADE;
DROP TABLE IF EXISTS polls CASCADE;
DROP TABLE IF EXISTS raised_hands CASCADE;
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS user_two_factor CASCADE;
DROP TABLE IF EXISTS virtual_backgrounds CASCADE;
DROP TABLE IF EXISTS whiteboard_sessions CASCADE;
`;

async function run() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(TABLES_SQL);
        await client.query('COMMIT');
        console.log('Dropped feature tables successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Failed to drop feature tables:', error.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

run();