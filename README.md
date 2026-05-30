# Sup!

Sup! is a full-stack video meeting workspace built for innovators, it has various tools integrated in your meeting to make your calls more productive and to make the workflow faster.

## Features

- Email/password auth with email verification
- Google and GitHub OAuth login/linking
- User profiles
- Instant and scheduled meetings
- Shareable meeting links
- WebRTC video/audio rooms
- Pre-join lobby with mic/camera controls
- In-meeting chat, attachments, reactions, raised hands, and host controls
- Tools: timer, checklist, notes, polls, transcription, whiteboard, breakout rooms
- Meeting recordings with optional Google Drive/GitHub sync
- Google Calendar and ICS support
- Past meeting audit logs with durations and activity history
- Admin APIs and dashboards for global users, meetings, and audit logs
- React + TypeScript migration started under `client/`

## Stack

- Node.js, Express, Socket.IO
- PostgreSQL, Drizzle ORM
- JWT, bcryptjs, Passport
- WebRTC
- React, TypeScript, Vite
- Multer, Nodemailer
- Three.js, HTML, CSS, vanilla JS

## Setup

```bash
npm install
```

Create a PostgreSQL database:

```sql
CREATE DATABASE sup_video_call;
```

Create `.env`:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/sup_video_call
JWT_SECRET=replace-with-a-long-random-secret
BASE_URL=http://localhost:3000
PORT=3000
NODE_ENV=development
```

Apply schema and compatibility backfills:

```bash
npm run db:push
node scripts/db-backfill.js
```

Run locally:

```bash
npm run dev
```

Open `http://localhost:3000`.

React client:

```bash
npm install --prefix client
npm run client:dev
npm run client:build
```

## Optional Env

Email:

```env
EMAIL_SERVICE=gmail
EMAIL_USER=
EMAIL_PASSWORD=
```

OAuth:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback
GITHUB_RECORDINGS_REPO=username/repo
GITHUB_RECORDINGS_BRANCH=main

GOOGLE_DRIVE_RECORDINGS_FOLDER_ID=
```

Admin:

```env
ADMIN_EMAILS=owner@example.com
ADMIN_USER_IDS=1
```

## Scripts

```bash
npm start       # start server
npm run dev     # start with nodemon
npm run client:dev
npm run client:build
npm run db:push # push Drizzle schema
npm run db:studio
```

## Main Routes

- `/` - login/register
- `/dashboard.html` - meetings and audit history
- `/app/dashboard` - React dashboard after `npm run client:build`
- `/admin.html` - legacy admin dashboard
- `/app/admin` - React admin dashboard after `npm run client:build`
- `/profile.html` - profile and account connections
- `/meeting.html?room=CODE` - meeting room
- `/join/:code` - shareable join link
- `/api/admin/*` - admin-only JSON APIs

## Notes

- Node.js 18.x is expected.
- Run `node scripts/db-backfill.js` after pulling schema changes.
- Audit logs use `meeting_audit_logs`; the server creates it on startup if needed.
- Camera/mic access requires `localhost` or HTTPS.
- Keep `.env` out of git.

## License

ISC
