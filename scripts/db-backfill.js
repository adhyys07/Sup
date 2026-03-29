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

const sqlStatements = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false;',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token varchar(255);',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_expires timestamp;',
    `CREATE TABLE IF NOT EXISTS oauth_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider varchar(50) NOT NULL,
        provider_id varchar(255) NOT NULL,
        email varchar(255),
        display_name varchar(255),
        avatar varchar(500),
        created_at timestamp DEFAULT now(),
        updated_at timestamp DEFAULT now()
    );`,
    'CREATE UNIQUE INDEX IF NOT EXISTS oauth_connections_user_provider_uq ON oauth_connections(user_id, provider);',
    `INSERT INTO oauth_connections (user_id, provider, provider_id, email, display_name, avatar, created_at, updated_at)
     SELECT
        id,
        auth_provider,
        COALESCE(auth_provider_id, id::text),
        email,
        name,
        avatar,
        now(),
        now()
     FROM users
     WHERE auth_provider IN ('google', 'github')
     ON CONFLICT (user_id, provider)
     DO UPDATE SET
        provider_id = EXCLUDED.provider_id,
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        avatar = EXCLUDED.avatar,
                updated_at = now();`,
        `UPDATE oauth_connections
         SET display_name = regexp_replace(split_part(email, '@', 1), '^[0-9]+\\+', ''),
                 updated_at = now()
         WHERE provider = 'github'
             AND email IS NOT NULL
             AND (
                        display_name IS NULL
                        OR display_name = ''
                        OR display_name ~* '@'
                        OR display_name = provider_id
             );`
];

(async () => {
    try {
        for (const statement of sqlStatements) {
            await pool.query(statement);
            console.log('Applied:', statement.split('\n')[0]);
        }
        console.log('DB backfill completed successfully.');
    } catch (err) {
        console.error('DB backfill failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
