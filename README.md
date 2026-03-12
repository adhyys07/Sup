# Sup! - Video Call Platform

A complete video calling application with authentication, user profiles, meeting scheduling, and real-time chat, built with Express.js, PostgreSQL, WebRTC, and Socket.io.

## Features

- **User Authentication**: Register and login with email/password
- **User Profiles**: Customize your profile with bio and avatar
- **Meeting Management**: Create, schedule, and join meetings
- **Meeting Codes**: Share unique codes to invite others
- **Video Conferencing**: Real-time video and audio using WebRTC
- **Chat**: In-meeting real-time chat with Socket.io
- **Meeting History**: View all your meetings and participants

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL with Drizzle ORM
- **Authentication**: JWT, bcryptjs
- **Real-time Communication**: Socket.io, WebRTC
- **Frontend**: HTML5, CSS3, Vanilla JavaScript

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Installation & Setup

### 1. Install Dependencies

```bash
npm install
```

This installs:
- express (web server)
- socket.io (real-time communication)
- drizzle-orm & drizzle-kit (database ORM)
- pg (PostgreSQL client)
- jsonwebtoken (JWT for authentication)
- bcryptjs (password hashing)
- cors (cross-origin requests)
- dotenv (environment variables)

### 2. Set Up PostgreSQL Database

**On Windows:**

1. Install PostgreSQL from [postgresql.org](https://www.postgresql.org/download/windows/)
2. During installation, remember the password you set for the `postgres` user
3. Open pgAdmin or psql terminal
4. Create a new database:

```sql
CREATE DATABASE sup_video_call;
```

**On macOS/Linux:**

```bash
createdb sup_video_call
```

### 3. Configure Environment Variables

Create a `.env` file in the project root with a PostgreSQL connection string:

```env
DATABASE_URL=postgresql://postgres:your_postgres_password@localhost:5432/sup_video_call
JWT_SECRET=your-secret-key-change-this-in-production
NODE_ENV=development
PORT=3000
```

If you prefer, the app still accepts the separate `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, and `DB_NAME` variables as a fallback.

### 4. Generate & Push Migrations

First, generate migrations from your Drizzle schema:

```bash
npm run db:push
```

This will:
1. Generate migration files based on your schema
2. Create all database tables automatically
3. Set up relationships and constraints

**Alternative: Use Drizzle Studio** (Interactive UI)

```bash
npm run db:studio
```

This opens a web interface to manage your database visually.

### 5. Start the Server

**Development mode (with auto-reload):**

```bash
npm run dev
```

**Production mode:**

```bash
npm start
```

The server will start on `http://localhost:3000`

## API Endpoints

### Authentication
- `POST /api/register` - Create new account
- `POST /api/login` - Login with email/password

### User Profile
- `GET /api/user/profile` - Get current user profile
- `PUT /api/user/profile` - Update profile

### Meetings
- `POST /api/meetings` - Create new meeting
- `GET /api/meetings` - Get all user's meetings
- `GET /api/meetings/:code` - Get specific meeting
- `POST /api/meetings/:code/join` - Join a meeting

### Chat
- `POST /api/meetings/:code/messages` - Send message
- `GET /api/meetings/:code/messages` - Get meeting chat history

## File Structure

```
Sup/
├── server.js              # Main Express server & API routes
├── db.js                  # Drizzle ORM configuration
├── schema.js              # Database schema definitions (Drizzle)
├── drizzle.config.js      # Drizzle Kit configuration
├── init-db.js             # Migration runner script
├── .env                   # Environment variables
├── package.json           # Dependencies
├── drizzle/               # Migration files (auto-generated)
├── public/
│   ├── index.html         # Login/Register page
│   ├── dashboard.html     # Meeting management
│   ├── profile.html       # User profile page
│   ├── meeting.html       # Video call & chat interface
│   └── script.js          # (optional) Shared scripts
└── README.md              # This file
```

## Usage

### 1. Register/Login
- Visit `http://localhost:3000`
- Create a new account or login
- Fill in your profile information

### 2. Create a Meeting
- From dashboard, click "New Meeting"
- Optionally set a title and time
- Meeting code is generated automatically

### 3. Join a Meeting
- Shared meeting code with others
- They can click "Join Meeting" and enter the code
- Or they can find it in their dashboard if you're connected

### 4. During Meeting
- Grant camera/microphone permissions
- See all participants' videos
- Use the Chat button to send messages
- Click Leave to exit

## Security Best Practices

1. **Change JWT_SECRET** in `.env` to a strong random string before production
2. **Use HTTPS** in production
3. **Database Backups** - Regularly backup your PostgreSQL database
4. **Rate Limiting** - Consider adding rate limiting to API endpoints
5. **CORS Configuration** - Update CORS settings for production domain
6. **Environment Variables** - Never commit `.env` to git

## Troubleshooting

### "Cannot find module 'pg'"
```bash
npm install pg
```

### Database connection fails
- Check PostgreSQL is running
- Verify `DATABASE_URL` in `.env`
- Ensure database `sup_video_call` exists

### Camera/Microphone not working
- Check browser permissions
- Must be on HTTPS or localhost
- Verify browser version supports WebRTC

### Meeting codes not working
- Codes are case-sensitive
- Code must exist (host must be online)
- Check database connection

## About Drizzle ORM

This project uses **Drizzle ORM** for type-safe database queries:

- **Type Safety**: Full TypeScript support (optional)
- **Zero Runtime**: Drizzle has minimal overhead
- **Developer Experience**: Simple, intuitive query API
- **Migrations**: Auto-generated schemas
- **Drizzle Studio**: Built-in visual database manager
- **Better than Raw SQL**: Prevents SQL injection automatically

### Useful Drizzle Commands

```bash
# Push schema changes to database
npm run db:push

# Open visual database manager
npm run db:studio

# Generate migration files
npx drizzle-kit generate:pg

# Drop all tables (careful!)
npx drizzle-kit drop
```

## Future Enhancements

- Screen sharing
- Meeting recordings
- Persistent meeting history with analytics
- Call scheduling and calendar integration
- Email notifications
- Admin dashboard
- Meeting access controls
- Group messaging

## License

ISC

## Support

For issues and questions, create an issue in the repository.

---

**Built with ❤️ using Node.js, Express, PostgreSQL, and WebRTC**
