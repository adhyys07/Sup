import 'dotenv/config';
import { Pool } from 'pg';

const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'sup_video_call'
    });

(async () => {
    try {
        const userCols = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'users'
              AND column_name IN ('email_verified', 'email_verification_token', 'email_verification_token_expires')
            ORDER BY column_name;
        `);

        const oauthTable = await pool.query(`
            SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_name = 'oauth_connections'
            ) AS exists;
        `);

        console.log('users_columns_found:', userCols.rows.map((r) => r.column_name));
        console.log('oauth_connections_exists:', oauthTable.rows[0].exists);
    } catch (err) {
        console.error('schema_check_failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
