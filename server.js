import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import passport from 'passport';
import { google } from 'googleapis';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import nodemailer from 'nodemailer';
import 'dotenv/config';
import { db } from './db.js';
import { users, meetings, meetingParticipants, messages, recordings, meetingAuditLogs, userTwoFactor, meetingReactions, raisedHands, meetingWaitingRoom, oauthConnections } from './schema.js';
import { eq, or, and, inArray, sql, desc } from 'drizzle-orm';
import speakeasy from 'speakeasy';
import ratelimit from 'express-rate-limit';
import { timestamp } from 'drizzle-orm/mysql-core';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const staticAssetOptions = {
    etag: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
            return;
        }

        if (filePath.includes(`${path.sep}vendor${path.sep}`) || /\.(js|css|woff2?)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        }
    }
};

// Middleware
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);
app.use(passport.initialize());
// Password gate for the admin panel HTML pages (defined below; hoisted).
app.use(adminPanelPageGate);
app.use(express.static('public', staticAssetOptions));

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GITHUB_OAUTH_SCOPES = ['user:email'];
const TEMP_ATTACHMENTS_DIR = path.join(process.cwd(), 'temp', 'meeting-attachments');
const MEETING_RECORDINGS_DIR = path.join(process.cwd(), 'storage', 'meeting-recordings');
const CLIENT_DIST_DIR = path.join(process.cwd(), 'client', 'dist');
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_RECORDING_BYTES = 300 * 1024 * 1024;

// Email configuration (using Gmail or custom SMTP)
const emailTransporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
    }
});

// Test email configuration
if (process.env.EMAIL_USER) {
    emailTransporter.verify((error, success) => {
        if (error) {
            console.log('Email service error:', error);
        } else {
            console.log('Email service ready');
        }
    });
}

fs.mkdirSync(TEMP_ATTACHMENTS_DIR, { recursive: true });
fs.mkdirSync(MEETING_RECORDINGS_DIR, { recursive: true });

const roomRuntimeMessages = new Map();
const roomCleanupTimers = new Map();
const roomChatBanned = new Map();
const roomChatLocked = new Map();
const instantRoomHosts = new Map();
const apiLimiter = ratelimit({
    windowMs: 15* 60 * 1000,
    max: 100,
    message: "Too many requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
});
const authLimiter = ratelimit({
    windowMs: 15* 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true
});

app.use('/api/', apiLimiter);

if (fs.existsSync(CLIENT_DIST_DIR)) {
    app.use('/app', express.static(CLIENT_DIST_DIR, staticAssetOptions));
    app.get('/app/*', (req, res) => {
        res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'));
    });
}

// Helper function to send verification email
async function sendVerificationEmail(email, name, token) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.error('Email verification is not configured. Set EMAIL_USER and EMAIL_PASSWORD.');
        return false;
    }

    const verificationUrl = `${BASE_URL}/verify-email.html?token=${token}`;
    const mailOptions = {
        from: `"Sup" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify your Sup account',
        html: `
            <h2>Welcome to Sup, ${name}!</h2>
            <p>Please verify your email address to activate your account.</p>
            <p><a href="${verificationUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify Email</a></p>
            <p>Or copy and paste this link: ${verificationUrl}</p>
            <p>This link will expire in 24 hours.</p>
            <p>If you didn't create this account, please ignore this email.</p>
        `
    };

    try {
        const info = await emailTransporter.sendMail(mailOptions);
        const accepted = Array.isArray(info.accepted) ? info.accepted.map((item) => String(item).toLowerCase()) : [];
        const rejected = Array.isArray(info.rejected) ? info.rejected : [];
        const target = String(email).toLowerCase();

        if (!accepted.includes(target)) {
            console.error('Verification email was not accepted by the provider:', {
                to: email,
                accepted: info.accepted,
                rejected,
                response: info.response
            });
            return false;
        }

        console.log('Verification email accepted:', {
            to: email,
            messageId: info.messageId,
            response: info.response
        });
        return true;
    } catch (error) {
        console.error('Error sending verification email:', error);
        return false;
    }
}

function getRoomAttachmentDir(roomCode) {
    return path.join(TEMP_ATTACHMENTS_DIR, roomCode);
}

function ensureRoomAttachmentDir(roomCode) {
    const roomDir = getRoomAttachmentDir(roomCode);
    fs.mkdirSync(roomDir, { recursive: true });
    return roomDir;
}

function getRoomRecordingDir(roomCode) {
    return path.join(MEETING_RECORDINGS_DIR, roomCode);
}

function ensureRoomRecordingDir(roomCode) {
    const roomDir = getRoomRecordingDir(roomCode);
    fs.mkdirSync(roomDir, { recursive: true });
    return roomDir;
}

function scheduleRoomCleanup(roomCode) {
    if (roomCleanupTimers.has(roomCode)) {
        clearTimeout(roomCleanupTimers.get(roomCode));
    }

    const timer = setTimeout(async () => {
        roomCleanupTimers.delete(roomCode);
        const activeRoom = io.sockets.adapter.rooms.get(roomCode);
        if (activeRoom && activeRoom.size > 0) {
            return;
        }

        roomRuntimeMessages.delete(roomCode);
        roomChatBanned.delete(roomCode);
        roomChatLocked.delete(roomCode);
        instantRoomHosts.delete(roomCode);
        fs.rmSync(getRoomAttachmentDir(roomCode), { recursive: true, force: true });

        try {
            const meeting = await getMeetingByCode(roomCode);
            await db.update(meetings)
                .set({ endedAt: new Date(), updatedAt: new Date() })
                .where(eq(meetings.meetingCode, roomCode));
            if (meeting) {
                await recordMeetingAudit({
                    meeting,
                    action: 'meeting_ended',
                    details: { reason: 'room_empty' },
                    durationSeconds: secondsBetween(meeting.startedAt, new Date())
                });
            }
        } catch (err) {
            console.error('Failed to mark meeting ended:', err);
        }
    }, 30000);

    roomCleanupTimers.set(roomCode, timer);
}

function cancelRoomCleanup(roomCode) {
    const timer = roomCleanupTimers.get(roomCode);
    if (!timer) return;
    clearTimeout(timer);
    roomCleanupTimers.delete(roomCode);
}

function secondsBetween(start, end) {
    if (!start || !end) return null;
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function auditDetails(details) {
    if (!details) return null;
    if (typeof details === 'string') return details;
    try {
        return JSON.stringify(details);
    } catch {
        return null;
    }
}

function parseAuditDetails(details) {
    if (!details) return null;
    try {
        return JSON.parse(details);
    } catch {
        return details;
    }
}

function getProfileAvatar(profile) {
    return profile?.photos?.[0]?.value || null;
}

async function syncUserAvatarIfMissing(user, avatar) {
    if (!user?.id || !avatar || user.avatar) return user;

    const updated = await db.update(users)
        .set({ avatar, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();

    return updated[0] || { ...user, avatar };
}

let meetingAuditSchemaReady = false;
let meetingAuditSchemaPromise = null;

async function ensureMeetingAuditSchema() {
    if (meetingAuditSchemaReady) return true;
    if (meetingAuditSchemaPromise) return meetingAuditSchemaPromise;

    meetingAuditSchemaPromise = (async () => {
        try {
            await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS meeting_audit_logs (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    meeting_id integer REFERENCES meetings(id) ON DELETE CASCADE,
                    meeting_code varchar(50) NOT NULL,
                    user_id integer REFERENCES users(id) ON DELETE SET NULL,
                    actor_name varchar(255),
                    action varchar(80) NOT NULL,
                    details text,
                    duration_seconds integer,
                    occurred_at timestamp DEFAULT now(),
                    created_at timestamp DEFAULT now()
                )
            `);
            await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audit_logs_meeting_idx ON meeting_audit_logs(meeting_id)`);
            await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audit_logs_code_idx ON meeting_audit_logs(meeting_code)`);
            await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audit_logs_user_idx ON meeting_audit_logs(user_id)`);
            await db.execute(sql`CREATE INDEX IF NOT EXISTS meeting_audit_logs_occurred_at_idx ON meeting_audit_logs(occurred_at)`);
            meetingAuditSchemaReady = true;
            return true;
        } catch (err) {
            meetingAuditSchemaPromise = null;
            console.error('Failed to ensure meeting audit schema:', err);
            return false;
        }
    })();

    return meetingAuditSchemaPromise;
}

async function recordMeetingAudit({
    meeting,
    meetingCode,
    userId = null,
    actorName = null,
    action,
    details = null,
    durationSeconds = null,
    occurredAt = new Date()
}) {
    if (!action || !(meeting?.id || meetingCode)) return;

    try {
        const schemaReady = await ensureMeetingAuditSchema();
        if (!schemaReady) return;

        await db.insert(meetingAuditLogs).values({
            meetingId: meeting?.id || null,
            meetingCode: meeting?.meetingCode || meetingCode,
            userId: userId || null,
            actorName: actorName || null,
            action,
            details: auditDetails(details),
            durationSeconds,
            occurredAt
        });
    } catch (err) {
        if (err?.code === '42P01') {
            meetingAuditSchemaReady = false;
            meetingAuditSchemaPromise = null;
            console.warn('Meeting audit table was missing; it will be recreated on the next audit write.');
            return;
        }

        console.error('Failed to write meeting audit log:', err);
    }
}

async function getMeetingByCode(roomCode) {
    const rows = await db.select().from(meetings).where(eq(meetings.meetingCode, roomCode));
    return rows[0] || null;
}

async function ensureInstantMeeting(roomCode, userId, title = 'Instant Meeting') {
    let meeting = await getMeetingByCode(roomCode);
    if (meeting || !userId) return meeting;

    try {
        const inserted = await db.insert(meetings).values({
            hostId: userId,
            title,
            meetingCode: roomCode,
            startedAt: new Date()
        }).returning();
        meeting = inserted[0] || null;
        if (meeting) {
            await recordMeetingAudit({
                meeting,
                userId,
                action: 'meeting_created',
                details: { source: 'instant' }
            });
        }
    } catch (err) {
        if (err?.code !== '23505') {
            console.error('Failed to create instant meeting:', err);
        }
        meeting = await getMeetingByCode(roomCode);
    }

    return meeting;
}

const attachmentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            cb(null, ensureRoomAttachmentDir(req.params.code));
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${randomUUID()}-${safeName}`);
    }
});

const uploadAttachment = multer({
    storage: attachmentStorage,
    limits: { fileSize: MAX_ATTACHMENT_BYTES }
});

const recordingStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            cb(null, ensureRoomRecordingDir(req.params.code));
        } catch (err) {
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${randomUUID()}.webm`);
    }
});

const uploadRecording = multer({
    storage: recordingStorage,
    limits: { fileSize: MAX_RECORDING_BYTES }
});

function buildAttachmentMessage(roomCode, userId, userName, file, overrides = {}) {
    return {
        id: `attachment-${randomUUID()}`,
        kind: 'attachment',
        userId,
        name: userName || 'User',
        message: '',
        createdAt: new Date().toISOString(),
        attachment: {
            id: randomUUID(),
            originalName: overrides.originalName || file.originalname,
            originalNameEncrypted: overrides.originalNameEncrypted === '1',
            storedName: file.filename,
            mimeType: overrides.mimeType || file.mimetype,
            size: overrides.size ? parseInt(overrides.size, 10) : file.size,
            url: `/api/meetings/${encodeURIComponent(roomCode)}/attachments/${encodeURIComponent(file.filename)}`
        }
    };
}

function getGoogleCalendarOAuthClient() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw new Error('Google OAuth is not configured');
    }

    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        `${BASE_URL}/auth/google/calendar/callback`
    );
}

async function createGoogleCalendarEventForUser(userId, meeting) {
    const result = await db.select({
        googleCalendarRefreshToken: users.googleCalendarRefreshToken
    }).from(users).where(eq(users.id, userId));

    const refreshToken = result[0]?.googleCalendarRefreshToken;
    if (!refreshToken) {
        return { inserted: false, reason: 'not-connected' };
    }

    try {
        const auth = getGoogleCalendarOAuthClient();
        auth.setCredentials({ refresh_token: refreshToken });

        const calendar = google.calendar({ version: 'v3', auth });
        const start = new Date(meeting.scheduledTime);
        const end = new Date(start.getTime() + 30 * 60 * 1000);

        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: meeting.title || 'Sup Meeting',
                description: `Join meeting: ${BASE_URL}/meeting.html?room=${meeting.meetingCode}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() }
            }
        });

        return {
            inserted: true,
            eventId: response.data.id,
            eventLink: response.data.htmlLink
        };
    } catch (err) {
        return {
            inserted: false,
            reason: 'insert-failed',
            error: err.message
        };
    }
}

async function getOrCreateDriveFolder(drive, folderName, parentId = null) {
    const escapedName = folderName.replace(/'/g, "\\'");
    const parentQuery = parentId ? ` and '${parentId}' in parents` : '';
    const query = `name='${escapedName}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentQuery}`;

    const existing = await drive.files.list({
        q: query,
        fields: 'files(id,name)',
        pageSize: 1,
        spaces: 'drive'
    });

    if (existing.data.files?.length) {
        return existing.data.files[0].id;
    }

    const created = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            ...(parentId ? { parents: [parentId] } : {})
        },
        fields: 'id'
    });

    return created.data.id;
}

async function uploadRecordingToGoogleDrive(userId, roomCode, localFilePath, localFileName, durationSeconds) {
    try {
        const userRows = await db.select({
            refreshToken: users.googleCalendarRefreshToken
        }).from(users).where(eq(users.id, userId));

        const refreshToken = userRows[0]?.refreshToken;
        if (!refreshToken) {
            return { uploaded: false, reason: 'google-not-connected' };
        }

        const auth = getGoogleCalendarOAuthClient();
        auth.setCredentials({ refresh_token: refreshToken });
        const drive = google.drive({ version: 'v3', auth });

        const rootFolderId = process.env.GOOGLE_DRIVE_RECORDINGS_FOLDER_ID || null;
        const recordingsFolderId = await getOrCreateDriveFolder(drive, 'Sup Recordings', rootFolderId);
        const meetingFolderId = await getOrCreateDriveFolder(drive, roomCode, recordingsFolderId);

        const upload = await drive.files.create({
            requestBody: {
                name: localFileName,
                parents: [meetingFolderId],
                description: `Sup meeting recording (${durationSeconds || 0}s)`
            },
            media: {
                mimeType: 'video/webm',
                body: fs.createReadStream(localFilePath)
            },
            fields: 'id,name,webViewLink,webContentLink'
        });

        return {
            uploaded: true,
            fileId: upload.data.id,
            name: upload.data.name,
            webViewLink: upload.data.webViewLink || null,
            webContentLink: upload.data.webContentLink || null
        };
    } catch (err) {
        return { uploaded: false, reason: 'google-drive-upload-failed', details: err.message };
    }
}

async function isHostForRoom(userId, roomCode) {
    const result = await db
        .select({ hostId: meetings.hostId })
        .from(meetings)
        .where(eq(meetings.meetingCode, roomCode));

    if (result.length > 0) {
        return result[0].hostId === userId;
    }

    return instantRoomHosts.get(roomCode) === userId;
}

function parseOwnerRepo(repoFullName) {
    if (!repoFullName || typeof repoFullName !== 'string' || !repoFullName.includes('/')) {
        return null;
    }
    const [owner, repo] = repoFullName.split('/');
    if (!owner || !repo) return null;
    return { owner, repo };
}

async function githubRequest(url, token, options = {}) {
    return fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'sup-meeting-app',
            ...(options.headers || {})
        }
    });
}

async function ensureGitHubRepoExists(owner, repo, token) {
    const check = await githubRequest(`https://api.github.com/repos/${owner}/${repo}`, token);
    if (check.ok) return true;
    if (check.status !== 404) return false;

    const create = await githubRequest('https://api.github.com/user/repos', token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: repo,
            private: true,
            auto_init: true,
            description: 'Sup meeting recordings'
        })
    });

    return create.ok;
}

async function uploadRecordingToLinkedGitHub(userId, roomCode, localFilePath, localFileName, durationSeconds) {
    try {
        const githubConn = await db.select({
            accessToken: oauthConnections.githubAccessToken,
            displayName: oauthConnections.displayName
        }).from(oauthConnections).where(and(
            eq(oauthConnections.userId, userId),
            eq(oauthConnections.provider, 'github')
        ));

        if (githubConn.length === 0) {
            return { uploaded: false, reason: 'github-not-linked' };
        }

        const token = githubConn[0].accessToken;
        if (!token) {
            return { uploaded: false, reason: 'github-token-missing' };
        }

        const githubUsername = (githubConn[0].displayName || '').replace(/^@/, '').trim();
        const repoFullName = process.env.GITHUB_RECORDINGS_REPO || (githubUsername ? `${githubUsername}/sup-recordings` : null);
        const repoParts = parseOwnerRepo(repoFullName);
        if (!repoParts) {
            return { uploaded: false, reason: 'github-repo-not-configured' };
        }

        const repoReady = await ensureGitHubRepoExists(repoParts.owner, repoParts.repo, token);
        if (!repoReady) {
            return { uploaded: false, reason: 'github-repo-unavailable' };
        }

        const fileBuffer = fs.readFileSync(localFilePath);
        const contentBase64 = fileBuffer.toString('base64');
        const repoPath = `recordings/${roomCode}/${Date.now()}-${localFileName}`;
        const branch = process.env.GITHUB_RECORDINGS_BRANCH || undefined;
        const commitMessage = `Add meeting recording ${roomCode} (${durationSeconds || 0}s)`;

        const uploadResponse = await githubRequest(
            `https://api.github.com/repos/${repoParts.owner}/${repoParts.repo}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, '/')}`,
            token,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: commitMessage,
                    content: contentBase64,
                    ...(branch ? { branch } : {})
                })
            }
        );

        if (!uploadResponse.ok) {
            const errBody = await uploadResponse.text();
            return { uploaded: false, reason: `github-upload-failed:${uploadResponse.status}`, details: errBody };
        }

        const payload = await uploadResponse.json();
        return {
            uploaded: true,
            repo: `${repoParts.owner}/${repoParts.repo}`,
            path: repoPath,
            htmlUrl: payload?.content?.html_url || null,
            downloadUrl: payload?.content?.download_url || null
        };
    } catch (err) {
        return { uploaded: false, reason: 'github-upload-error', details: err.message };
    }
}
// ============ PASSPORT CONFIG ============
async function findOrCreateOAuthUser(profile, provider, linkingInfo = null, oauthData = {}) {
    const providerId = String(profile.id);
    const email = profile.emails?.[0]?.value || null;
    const avatar = getProfileAvatar(profile);
    const providerDisplayName = provider === 'github'
        ? (profile.username || profile.displayName || email || `github-${providerId}`)
        : (profile.displayName || email);

    // GitHub may not provide email for some accounts. In that case,
    // try to find user by existing provider connection first.
    if (!email && provider === 'github' && !(linkingInfo && linkingInfo.action === 'link')) {
        const existingOAuthByProviderId = await db.select().from(oauthConnections)
            .where(and(eq(oauthConnections.provider, provider), eq(oauthConnections.providerId, providerId)));

        if (existingOAuthByProviderId.length > 0) {
            const oauthRow = existingOAuthByProviderId[0];
            await db.update(oauthConnections)
                .set({
                    displayName: providerDisplayName,
                    avatar,
                    updatedAt: new Date()
                })
                .where(eq(oauthConnections.id, oauthRow.id));

            const linkedUser = await db.select().from(users).where(eq(users.id, oauthRow.userId));
            if (linkedUser.length > 0) return await syncUserAvatarIfMissing(linkedUser[0], avatar);
        }
    }

    const existing = email
        ? await db.select().from(users).where(eq(users.email, email))
        : [];

    // If this is an account linking request
    if (linkingInfo && linkingInfo.action === 'link' && linkingInfo.userId) {
        const linkedUser = await db.select().from(users).where(eq(users.id, linkingInfo.userId));
        
        if (linkedUser.length > 0) {
            // Check if this provider is already linked
            const existingOAuth = await db.select().from(oauthConnections)
                .where(and(eq(oauthConnections.userId, linkingInfo.userId), eq(oauthConnections.provider, provider)));
            
            if (existingOAuth.length > 0) {
                // Update existing connection
                await db.update(oauthConnections)
                    .set({
                        providerId,
                        email: email || linkedUser[0].email || null,
                        displayName: providerDisplayName,
                        avatar,
                        githubAccessToken: provider === 'github' ? (oauthData.accessToken || existingOAuth[0].githubAccessToken || null) : existingOAuth[0].githubAccessToken,
                        updatedAt: new Date()
                    })
                    .where(eq(oauthConnections.id, existingOAuth[0].id));
            } else {
                // Create new OAuth connection
                await db.insert(oauthConnections).values({
                    userId: linkingInfo.userId,
                    provider,
                    providerId,
                    email: email || linkedUser[0].email || null,
                    displayName: providerDisplayName,
                    avatar,
                    githubAccessToken: provider === 'github' ? (oauthData.accessToken || null) : null
                });
            }
            
            return await syncUserAvatarIfMissing(linkedUser[0], avatar);
        } else {
            throw new Error('User not found for linking');
        }
    }

    if (existing.length > 0) {
        const existingUser = existing[0];

        // Ensure OAuth connection exists for returning users who authenticate via OAuth.
        const existingOAuth = await db.select().from(oauthConnections)
            .where(and(eq(oauthConnections.userId, existingUser.id), eq(oauthConnections.provider, provider)));

        if (existingOAuth.length > 0) {
            await db.update(oauthConnections)
                .set({
                    providerId,
                    email: email || existingUser.email || null,
                    displayName: providerDisplayName,
                    avatar,
                    githubAccessToken: provider === 'github' ? (oauthData.accessToken || existingOAuth[0].githubAccessToken || null) : existingOAuth[0].githubAccessToken,
                    updatedAt: new Date()
                })
                .where(eq(oauthConnections.id, existingOAuth[0].id));
        } else {
            await db.insert(oauthConnections).values({
                userId: existingUser.id,
                provider,
                providerId,
                email: email || existingUser.email || null,
                displayName: providerDisplayName,
                avatar,
                githubAccessToken: provider === 'github' ? (oauthData.accessToken || null) : null
            });
        }

        return await syncUserAvatarIfMissing(existingUser, avatar);
    }

    // New local user record cannot be created without email.
    if (!email) {
        throw new Error('No email from provider. Make your GitHub email public or link GitHub from profile settings first.');
    }

    // Create new user
    const result = await db.insert(users).values({
        email,
        name: profile.displayName || email,
        avatar,
        authProvider: provider,
        authProviderId: providerId,
        emailVerified: true  // OAuth users are auto-verified
    }).returning();

    // Create OAuth connection entry
    if (result.length > 0) {
        await db.insert(oauthConnections).values({
            userId: result[0].id,
            provider,
            providerId,
            email,
            displayName: providerDisplayName,
            avatar,
            githubAccessToken: provider === 'github' ? (oauthData.accessToken || null) : null
        });
    }

    return result[0];
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`,
        scope: ['profile', 'email'],
        proxy: true,
        passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, done) => {
        try {
            let linkingInfo = null;
            
            // Check if this is an account linking request
            try {
                if (req.query && req.query.state) {
                    linkingInfo = jwt.verify(req.query.state, JWT_SECRET);
                }
            } catch (err) {
                // Not a valid linking token, proceed with normal auth
            }

            const user = await findOrCreateOAuthUser(profile, 'google', linkingInfo);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    }));

    passport.use('google-calendar', new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/calendar/callback`,
        scope: ['profile', 'email', GOOGLE_CALENDAR_SCOPE, GOOGLE_DRIVE_SCOPE],
        proxy: true,
        passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, done) => {
        try {
            const decoded = jwt.verify(req.query.state, JWT_SECRET);
            done(null, {
                userId: decoded.userId,
                googleCalendarEmail: profile.emails?.[0]?.value || null,
                refreshToken
            });
        } catch (err) {
            done(err, null);
        }
    }));
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy({
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/github/callback`,
        scope: GITHUB_OAUTH_SCOPES,
        passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, done) => {
        try {
            let linkingInfo = null;
            
            // Check if this is an account linking request
            try {
                if (req.query && req.query.state) {
                    linkingInfo = jwt.verify(req.query.state, JWT_SECRET);
                }
            } catch (err) {
                // Not a valid linking token, proceed with normal auth
            }

            const user = await findOrCreateOAuthUser(profile, 'github', linkingInfo, { accessToken });
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    }));
}

// ============ OAUTH ROUTES ============
app.get('/auth/google', passport.authenticate('google', { session: false, scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/' }),
    (req, res) => {
        const token = jwt.sign({ id: req.user.id }, JWT_SECRET);
        
        // Check if this was an account linking flow
        if (req.query.state) {
            try {
                const decoded = jwt.verify(req.query.state, JWT_SECRET);
                if (decoded.action === 'link') {
                    // Redirect to profile with success message
                    return res.redirect(`/profile.html?linked=google&token=${token}`);
                }
            } catch (err) {
                // Continue with normal auth flow
            }
        }
        
        res.redirect(`/auth-success.html?token=${token}`);
    }
);

app.get('/auth/google/calendar', (req, res, next) => {
    const token = req.query.token;
    if (!token) {
        return res.status(401).send('Missing token');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const state = jwt.sign({ userId: decoded.id, purpose: 'google-calendar-connect' }, JWT_SECRET, { expiresIn: '10m' });

        passport.authenticate('google-calendar', {
            session: false,
            scope: ['profile', 'email', GOOGLE_CALENDAR_SCOPE, GOOGLE_DRIVE_SCOPE],
            accessType: 'offline',
            prompt: 'consent',
            state
        })(req, res, next);
    } catch (err) {
        res.status(401).send('Invalid token');
    }
});

app.get('/auth/google/calendar/callback',
    passport.authenticate('google-calendar', { session: false, failureRedirect: '/dashboard.html?calendar=error' }),
    async (req, res) => {
        try {
            if (!req.user?.userId || !req.user?.refreshToken) {
                return res.redirect('/dashboard.html?calendar=error');
            }

            await db.update(users)
                .set({
                    googleCalendarEmail: req.user.googleCalendarEmail,
                    googleCalendarRefreshToken: req.user.refreshToken,
                    updatedAt: new Date()
                })
                .where(eq(users.id, req.user.userId));

            res.redirect('/dashboard.html?calendar=connected');
        } catch (err) {
            res.redirect('/dashboard.html?calendar=error');
        }
    }
);

app.get('/auth/github', passport.authenticate('github', { session: false, scope: GITHUB_OAUTH_SCOPES }));

app.get('/auth/github/callback',
    passport.authenticate('github', { session: false, failureRedirect: '/' }),
    (req, res) => {
        const token = jwt.sign({ id: req.user.id }, JWT_SECRET);
        
        // Check if this was an account linking flow
        if (req.query.state) {
            try {
                const decoded = jwt.verify(req.query.state, JWT_SECRET);
                if (decoded.action === 'link') {
                    // Redirect to profile with success message
                    return res.redirect(`/profile.html?linked=github&token=${token}`);
                }
            } catch (err) {
                // Continue with normal auth flow
            }
        }
        
        res.redirect(`/auth-success.html?token=${token}`);
    }
);

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.id;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

function envList(name) {
    return String(process.env[name] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parsePositiveInt(value, fallback, max = 100) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
}

function countValue(rows) {
    return Number(rows?.[0]?.count || rows?.[0]?.total || 0);
}

function compactWhere(conditions) {
    const filtered = conditions.filter(Boolean);
    if (!filtered.length) return null;
    return filtered.length === 1 ? filtered[0] : and(...filtered);
}

async function requireAdmin(req, res, next) {
    try {
        const adminIds = new Set(envList('ADMIN_USER_IDS').map((id) => Number(id)).filter(Number.isFinite));
        const adminEmails = new Set(envList('ADMIN_EMAILS').map((email) => email.toLowerCase()));

        if (!adminIds.size && !adminEmails.size) {
            console.warn('Admin route denied because ADMIN_EMAILS and ADMIN_USER_IDS are not configured.');
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (adminIds.has(Number(req.userId))) {
            req.admin = { id: req.userId };
            return next();
        }

        const result = await db.select({
            id: users.id,
            email: users.email,
            name: users.name
        }).from(users).where(eq(users.id, req.userId));

        const user = result[0];
        if (!user || !adminEmails.has(String(user.email || '').toLowerCase())) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        req.admin = user;
        next();
    } catch (err) {
        console.error('Admin auth error:', err);
        res.status(500).json({ error: 'Unable to verify admin access' });
    }
}

// ============ ADMIN PANEL PASSWORD GATE ============
// A shared password that unlocks the admin panel, layered ON TOP of the
// existing JWT + ADMIN_EMAILS/ADMIN_USER_IDS checks. Set ADMIN_PANEL_PASSWORD
// (plaintext) or ADMIN_PANEL_PASSWORD_HASH (bcrypt) to enable the panel.
const ADMIN_GATE_COOKIE = 'admin_gate';
const ADMIN_GATE_SCOPE = 'admin-panel-gate';
const ADMIN_GATE_TTL_HOURS = parsePositiveInt(process.env.ADMIN_PANEL_SESSION_HOURS, 8, 168);
const ADMIN_PANEL_PAGES = new Set(['/admin.html', '/admin-stats.html']);

function adminPanelPasswordConfigured() {
    return Boolean(process.env.ADMIN_PANEL_PASSWORD_HASH || process.env.ADMIN_PANEL_PASSWORD);
}

async function verifyAdminPanelPassword(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const hash = process.env.ADMIN_PANEL_PASSWORD_HASH;
    if (hash) {
        try { return await bcrypt.compare(candidate, hash); } catch { return false; }
    }
    const plain = process.env.ADMIN_PANEL_PASSWORD;
    if (!plain) return false;
    // Constant-time compare over fixed-length digests (avoids length leaks).
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(String(plain)).digest();
    return timingSafeEqual(a, b);
}

function issueAdminGateToken() {
    return jwt.sign({ scope: ADMIN_GATE_SCOPE }, JWT_SECRET, { expiresIn: `${ADMIN_GATE_TTL_HOURS}h` });
}

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

function hasAdminGate(req) {
    const token = readCookie(req, ADMIN_GATE_COOKIE);
    if (!token) return false;
    try {
        return jwt.verify(token, JWT_SECRET)?.scope === ADMIN_GATE_SCOPE;
    } catch {
        return false;
    }
}

function setAdminGateCookie(res, token) {
    res.cookie(ADMIN_GATE_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: BASE_URL.startsWith('https'),
        maxAge: ADMIN_GATE_TTL_HOURS * 60 * 60 * 1000,
        path: '/'
    });
}

// Middleware (hoisted) — gates the admin HTML pages before express.static serves them.
function adminPanelPageGate(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!ADMIN_PANEL_PAGES.has(req.path)) return next();

    if (!adminPanelPasswordConfigured()) {
        return res.status(503).type('html').send(
            '<h1>Admin panel locked</h1><p>Set <code>ADMIN_PANEL_PASSWORD</code> ' +
            '(or <code>ADMIN_PANEL_PASSWORD_HASH</code>) on the server to enable access.</p>'
        );
    }
    if (hasAdminGate(req)) return next();
    return res.redirect(302, `/admin-login.html?next=${encodeURIComponent(req.originalUrl)}`);
}

// Extra layer on the admin API: require the panel password in addition to
// the JWT + admin-allowlist checks already on each /api/admin/* route.
function requireAdminGateApi(req, res, next) {
    if (!adminPanelPasswordConfigured()) {
        return res.status(503).json({ error: 'Admin panel password not configured' });
    }
    if (!hasAdminGate(req)) {
        return res.status(401).json({ error: 'Admin panel locked', code: 'ADMIN_GATE_REQUIRED' });
    }
    next();
}
app.use('/api/admin', requireAdminGateApi);

// Unlock / lock endpoints (deliberately NOT under /api/admin so they aren't self-gated).
app.post('/api/admin-gate/login', authLimiter, async (req, res) => {
    if (!adminPanelPasswordConfigured()) {
        return res.status(503).json({ error: 'Admin panel password not configured' });
    }
    const ok = await verifyAdminPanelPassword(req.body?.password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    setAdminGateCookie(res, issueAdminGateToken());
    res.json({ ok: true });
});

app.post('/api/admin-gate/logout', (req, res) => {
    res.clearCookie(ADMIN_GATE_COOKIE, { path: '/' });
    res.json({ ok: true });
});

app.get('/api/admin-gate/status', (req, res) => {
    res.json({ configured: adminPanelPasswordConfigured(), unlocked: hasAdminGate(req) });
});

// ============ AUTH ROUTES ============
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { email, password, name } = req.body;

        // Validate input
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'Email, password, and name are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Check if email already exists
        const existingUser = await db.select().from(users).where(eq(users.email, email));
        if (existingUser.length > 0) {
            const user = existingUser[0];
            // Check if they signed up with a different provider
            if (user.authProvider !== 'local' && user.authProvider) {
                return res.status(409).json({ 
                    error: `This email is already registered using ${user.authProvider}. Please log in with ${user.authProvider} instead or use a different email.`,
                    existingProvider: user.authProvider,
                    code: 'PROVIDER_MISMATCH'
                });
            }
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate verification token (valid for 24 hours)
        const verificationToken = randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Create user with unverified status
        const result = await db.insert(users).values({
            email,
            password: hashedPassword,
            name,
            authProvider: 'local',
            emailVerified: false,
            emailVerificationToken: verificationToken,
            emailVerificationTokenExpires: tokenExpires
        }).returning({ id: users.id, email: users.email, name: users.name });

        // Send verification email
        const emailSent = await sendVerificationEmail(email, name, verificationToken);

        if (!emailSent) {
            // If email fails to send, delete the unverified user so the user can retry cleanly.
            await db.delete(users).where(eq(users.id, result[0].id));
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }

        res.status(201).json({ 
            message: 'Account created. Verification email sent. Please check your inbox.',
            email: email
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password, twoFactorToken } = req.body;
        const result = await db.select().from(users).where(eq(users.email, email));
        
        if (result.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if email is verified (only for local auth)
        if (user.authProvider === 'local' && !user.emailVerified) {
            return res.status(403).json({ error: 'Please verify your email before logging in. Check your inbox for a verification link.' });
        }

        const twoFa = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, user.id));

        if(twoFa[0]?.enabled && !twoFactorToken){
            return res.json({ requiredTwoFactor: true, temptoken: jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '5m' }) });
        }

        if (twoFa[0]?.enabled) {
            const verified= speakeasy.totp.verify({
                secret: twoFa[0].secret,
                token: twoFactorToken,
                window: 2
            });
            if (!verified) return res.status(401).json({ error: 'Invalid 2FA token' });
        }
        
        const token = jwt.sign({ id: user.id }, JWT_SECRET);
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Keep older verification emails working if they point to /verify-email.
app.get('/verify-email', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    res.redirect(`/verify-email.html${query}`);
});

// Verify email endpoint
app.post('/api/verify-email', authLimiter, async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Verification token is required' });
        }

        // Find user with the verification token
        const result = await db.select().from(users).where(eq(users.emailVerificationToken, token));

        if (result.length === 0) {
            return res.status(400).json({ error: 'Invalid verification token' });
        }

        const user = result[0];

        // Check if token has expired
        if (user.emailVerificationTokenExpires && new Date() > user.emailVerificationTokenExpires) {
            return res.status(400).json({ error: 'Verification token has expired. Please sign up again.' });
        }

        // Mark email as verified and clear the token
        await db.update(users)
            .set({
                emailVerified: true,
                emailVerificationToken: null,
                emailVerificationTokenExpires: null,
                updatedAt: new Date()
            })
            .where(eq(users.id, user.id));

        res.json({ 
            message: 'Email verified successfully! You can now log in.' 
        });
    } catch (err) {
        console.error('Email verification error:', err);
        res.status(400).json({ error: err.message });
    }
});

// Resend verification email
app.post('/api/resend-verification', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const result = await db.select().from(users).where(eq(users.email, email));

        if (result.length === 0) {
            return res.status(400).json({ error: 'User not found' });
        }

        const user = result[0];

        // Check if already verified
        if (user.emailVerified) {
            return res.status(400).json({ error: 'Email is already verified' });
        }

        // Generate new verification token
        const verificationToken = randomBytes(32).toString('hex');
        const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Update user with new token
        await db.update(users)
            .set({
                emailVerificationToken: verificationToken,
                emailVerificationTokenExpires: tokenExpires,
                updatedAt: new Date()
            })
            .where(eq(users.id, user.id));

        // Send verification email
        const emailSent = await sendVerificationEmail(user.email, user.name, verificationToken);

        if (!emailSent) {
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }

        res.json({ 
            message: 'Verification email sent! Please check your inbox.' 
        });
    } catch (err) {
        console.error('Resend verification error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/user/theme', verifyToken, async (req, res) => {
    try {
        const { theme } = req.body;

        await db.insert(userPreferences).values({
            userId: req.userId,
            theme
        }).onConflictDoUpdate({
            target: userPreferences.userId,
            set: { theme, updatedAt: new Date() }
        });

        res.json({ theme });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/user/theme', verifyToken, async (req, res) => {
    try {
        const result = await db.select().from(userPreferences).where(eq(userPreferences.userId, req.userId));
        res.json({ theme: result[0]?.theme || 'light' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// ============ USER PROFILE ROUTES ============
app.get('/api/user/profile', verifyToken, async (req, res) => {
    try {
        const result = await db.select({
            id: users.id,
            email: users.email,
            name: users.name,
            bio: users.bio,
            avatar: users.avatar,
            googleCalendarEmail: users.googleCalendarEmail,
            googleCalendarRefreshToken: users.googleCalendarRefreshToken
        }).from(users).where(eq(users.id, req.userId));

        if (!result[0]) {
            return res.status(404).json({ error: 'User not found' });
        }

        let avatar = result[0].avatar;
        if (!avatar) {
            try {
                const oauthRows = await db.select({ avatar: oauthConnections.avatar })
                    .from(oauthConnections)
                    .where(eq(oauthConnections.userId, req.userId));
                avatar = oauthRows.find((row) => row.avatar)?.avatar || null;
                if (avatar) {
                    await syncUserAvatarIfMissing(result[0], avatar);
                }
            } catch (avatarErr) {
                console.warn('Unable to load OAuth avatar fallback:', avatarErr?.message || avatarErr);
            }
        }

        res.json({
            id: result[0].id,
            email: result[0].email,
            name: result[0].name,
            bio: result[0].bio,
            avatar,
            googleCalendarEmail: result[0].googleCalendarEmail,
            googleCalendarConnected: !!result[0].googleCalendarRefreshToken
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/user/profile', verifyToken, async (req, res) => {
    try {
        const { name, bio, avatar } = req.body;
        const result = await db.update(users)
            .set({ name, bio, avatar, updatedAt: new Date() })
            .where(eq(users.id, req.userId))
            .returning({
                id: users.id,
                email: users.email,
                name: users.name,
                bio: users.bio,
                avatar: users.avatar
            });
        
        res.json(result[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

        // Get connected accounts/providers
        app.get('/api/user/connections', verifyToken, async (req, res) => {
            try {
                console.log('Fetching connections for user:', req.userId);
                const user = await db.select({
                    id: users.id,
                    email: users.email,
                    name: users.name,
                    password: users.password,
                    authProvider: users.authProvider,
                    authProviderId: users.authProviderId
                }).from(users).where(eq(users.id, req.userId));
                
                if (user.length === 0) {
                    console.log('User not found:', req.userId);
                    return res.status(404).json({ error: 'User not found' });
                }

                const userData = user[0];
                console.log('User data:', userData.id, userData.email);
        const connections = {};

        // Check if they have local auth (email & password)
        if (userData.password) {
            connections.local = {
                provider: 'local',
                connected: true,
                type: 'Email & Password'
            };
        }

        // Check OAuth connections from the oauth_connections table.
        // If the table is missing in the current DB, fall back to legacy users.authProvider.
        let oauthConns = [];
        try {
            oauthConns = await db.select().from(oauthConnections).where(eq(oauthConnections.userId, req.userId));
            console.log('OAuth connections found:', oauthConns.length);
        } catch (oauthErr) {
            const oauthErrorMessage = oauthErr?.message || '';
            console.error('OAuth connections query failed:', oauthErrorMessage);

            const missingOauthTable = oauthErrorMessage.includes('oauth_connections') && oauthErrorMessage.includes('does not exist');
            if (missingOauthTable) {
                console.log('Falling back to legacy authProvider field for user:', req.userId);
                if (userData.authProvider && userData.authProvider !== 'local') {
                    oauthConns = [{
                        provider: userData.authProvider,
                        providerId: userData.authProviderId,
                        email: userData.email,
                        displayName: userData.name
                    }];
                }
            } else {
                throw oauthErr;
            }
        }
        
        oauthConns.forEach(conn => {
            console.log('Processing OAuth connection:', conn.provider, conn.providerId);
            if (conn.provider === 'google') {
                connections.google = {
                    provider: 'google',
                    connected: true,
                    type: 'Google',
                    email: conn.email,
                    displayName: conn.displayName
                };
            } else if (conn.provider === 'github') {
                const githubUsername = conn.displayName ? conn.displayName.replace(/^@/, '') : null;
                connections.github = {
                    provider: 'github',
                    connected: true,
                    type: 'GitHub',
                    displayName: conn.displayName,
                    githubUsername
                };
            }
        });

        console.log('Sending connections response:', Object.keys(connections));
        res.json({ connections });
    } catch (err) {
        console.error('Error fetching connections:', err);
        console.error('Stack trace:', err.stack);
        res.status(500).json({ error: err.message });
    }
});

// Link Google account (requires current auth)
app.post('/api/user/link-provider/google', verifyToken, async (req, res) => {
    try {
        // Create a state token that includes the user ID and action
        const linkingState = jwt.sign(
            { userId: req.userId, action: 'link', provider: 'google' }, 
            JWT_SECRET, 
            { expiresIn: '30m' }
        );

        const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        googleAuthUrl.searchParams.append('client_id', process.env.GOOGLE_CLIENT_ID);
        googleAuthUrl.searchParams.append('redirect_uri', `${BASE_URL}/auth/google/callback`);
        googleAuthUrl.searchParams.append('response_type', 'code');
        googleAuthUrl.searchParams.append('scope', 'openid email profile');
        googleAuthUrl.searchParams.append('state', linkingState);

        res.json({
            redirectUrl: googleAuthUrl.toString()
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Link GitHub account
app.post('/api/user/link-provider/github', verifyToken, async (req, res) => {
    try {
        const linkingState = jwt.sign(
            { userId: req.userId, action: 'link', provider: 'github' }, 
            JWT_SECRET, 
            { expiresIn: '30m' }
        );

        const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
        githubAuthUrl.searchParams.append('client_id', process.env.GITHUB_CLIENT_ID);
        githubAuthUrl.searchParams.append('redirect_uri', `${BASE_URL}/auth/github/callback`);
        githubAuthUrl.searchParams.append('scope', GITHUB_OAUTH_SCOPES.join(' '));
        githubAuthUrl.searchParams.append('state', linkingState);

        res.json({
            redirectUrl: githubAuthUrl.toString()
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Unlink provider
app.post('/api/user/unlink-provider/:provider', verifyToken, async (req, res) => {
    try {
        const { provider } = req.params;
        const validProviders = ['google', 'github'];

        if (!validProviders.includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider' });
        }

        // Get user
        const user = await db.select({
            id: users.id,
            password: users.password
        }).from(users).where(eq(users.id, req.userId));
        if (user.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = user[0];

        // Check how many authentication methods the user has
        let oauthConns = [];
        try {
            oauthConns = await db.select().from(oauthConnections)
                .where(eq(oauthConnections.userId, req.userId));
        } catch (oauthErr) {
            const oauthErrorMessage = oauthErr?.message || '';
            const missingOauthTable = oauthErrorMessage.includes('oauth_connections') && oauthErrorMessage.includes('does not exist');

            if (missingOauthTable) {
                oauthConns = [];
            } else {
                throw oauthErr;
            }
        }
        
        const hasPassword = !!userData.password;
        const oauthProviderCount = oauthConns.length;

        // Make sure they have another way to login
        if (!hasPassword && oauthProviderCount <= 1) {
            return res.status(400).json({ 
                error: 'You must have at least one login method. Keep this provider or set a password first.' 
            });
        }

        // Delete the OAuth connection
        await db.delete(oauthConnections)
            .where(and(
                eq(oauthConnections.userId, req.userId),
                eq(oauthConnections.provider, provider)
            ));

        res.json({ message: `${provider} account has been unlinked` });
    } catch (err) {
        console.error('Error unlinking provider:', err);
        res.status(400).json({ error: err.message });
    }
});

// ============ ADMIN ROUTES ============
app.get('/api/admin/summary', verifyToken, requireAdmin, async (req, res) => {
    try {
        await ensureMeetingAuditSchema();

        const now = new Date();
        const [
            userCountRows,
            meetingCountRows,
            activeMeetingRows,
            scheduledMeetingRows,
            auditCountRows,
            recordingCountRows,
            messageCountRows
        ] = await Promise.all([
            db.select({ count: sql`count(*)` }).from(users),
            db.select({ count: sql`count(*)` }).from(meetings),
            db.select({ count: sql`count(*)` }).from(meetings)
                .where(and(sql`${meetings.startedAt} IS NOT NULL`, sql`${meetings.endedAt} IS NULL`)),
            db.select({ count: sql`count(*)` }).from(meetings)
                .where(and(sql`${meetings.scheduledTime} >= ${now}`, sql`${meetings.startedAt} IS NULL`)),
            db.select({ count: sql`count(*)` }).from(meetingAuditLogs),
            db.select({ count: sql`count(*)` }).from(recordings),
            db.select({ count: sql`count(*)` }).from(messages)
        ]);

        const recentLogs = await db.select({
            id: meetingAuditLogs.id,
            meetingId: meetingAuditLogs.meetingId,
            meetingCode: meetingAuditLogs.meetingCode,
            actorName: meetingAuditLogs.actorName,
            action: meetingAuditLogs.action,
            details: meetingAuditLogs.details,
            durationSeconds: meetingAuditLogs.durationSeconds,
            occurredAt: meetingAuditLogs.occurredAt,
            meetingTitle: meetings.title
        })
        .from(meetingAuditLogs)
        .leftJoin(meetings, eq(meetingAuditLogs.meetingId, meetings.id))
        .orderBy(desc(meetingAuditLogs.occurredAt))
        .limit(10);

        res.json({
            totals: {
                users: countValue(userCountRows),
                meetings: countValue(meetingCountRows),
                activeMeetings: countValue(activeMeetingRows),
                scheduledMeetings: countValue(scheduledMeetingRows),
                auditLogs: countValue(auditCountRows),
                recordings: countValue(recordingCountRows),
                messages: countValue(messageCountRows)
            },
            recentAuditLogs: recentLogs.map((log) => ({
                ...log,
                details: parseAuditDetails(log.details)
            }))
        });
    } catch (err) {
        console.error('Admin summary error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/stats'  , verifyToken, requireAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 365);
        const now = new Date();
        const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const prevSince = new Date(now.getTime() - 2 * days * 86400000);

        const inWindow = (col) => sql`${col} >= ${since}`;
        const inPrevWindow = (col) => and(sql`${col} >= ${prevSince}`, sql`${col} < ${since}`);
        const count = () => sql`count(*)::int`;

        const [
            meetingsPerDay,
            usersPerDay,
            messagesPerDay,
            heatmapRows,
            topHosts,
            durationRows,
            providerRows,
            reactionRows,
            userTotalRows,
            meetingsWindowRows, meetingsPrevRows,
            usersWindowRows, usersPrevRows,
            messagesWindowRows, messagesPrevRows,
            recordingsWindowRows, recordingsPrevRows,
            activeNowRows 
        ] = await Promise.all([
            db.select({
                day: sql`date_trunc('day', ${meetings.createdAt})`,
                count: count()}).from(meetings).where(inWindow(meetings.createdAt)).groupBy(sql`1`).orderBy(sql`1`),
            db.select({
                day: sql`date_trunc('day', ${users.createdAt})`,
                count: count()}).from(users).where(inWindow(users.createdAt)).groupBy(sql`1`).orderBy(sql`1`),      
            
            db.select({
                day: sql`date_trunc('day', ${messages.createdAt})`,
                count: count()}).from(messages).where(inWindow(messages.createdAt)).groupBy(sql`1`).orderBy(sql`1`),    
            
            db.select({
                dow: sql`extract(dow from ${meetings.startedAt})::int`,
                hour: sql`extract(hour from ${meetings.startedAt})::int`,
                count: count()
            }).from(meetings).where(inWindow(meetings.startedAt)).groupBy(sql`1, 2`),

            db.select({ name: users.name, count: count() })
                .from(meetings)
                .innerJoin(users, eq(meetings.hostId, users.id))
                .where(inWindow(meetings.createdAt))
                .groupBy(users.id, users.name)
                .orderBy(sql`count(*) desc`)
                .limit(8),  
            
            db.select({ minutes: sql`extract(epoch from (${meetings.endedAt} - ${meetings.startedAt})) / 60` })
                .from(meetings)
                .where(and(
                    sql`${meetings.startedAt} IS NOT NULL`,
                    sql`${meetings.endedAt} IS NOT NULL`,
                    inWindow(meetings.startedAt)
                )),

            // Sign-in method split (all time — it's a population, not a flow)
            db.select({ provider: users.authProvider, count: count() })
                .from(users).groupBy(users.authProvider),

            // Top reactions in the window
            db.select({ emoji: meetingReactions.emoji, count: count() })
                .from(meetingReactions)
                .where(inWindow(meetingReactions.createdAt))
                .groupBy(meetingReactions.emoji)
                .orderBy(sql`count(*) desc`)
                .limit(6),
            
            db.select({ count: count() }).from(users),
            db.select({ count: count() }).from(meetings).where(inWindow(meetings.createdAt)),
            db.select({ count: count() }).from(meetings).where(inPrevWindow(meetings.createdAt)),
            db.select({ count: count() }).from(users).where(inWindow(users.createdAt)),
            db.select({ count: count() }).from(users).where(inPrevWindow(users.createdAt)),
            db.select({ count: count() }).from(messages).where(inWindow(messages.createdAt)),
            db.select({ count: count() }).from(messages).where(inPrevWindow(messages.createdAt)),
            db.select({ count: count() }).from(recordings).where(inWindow(recordings.createdAt)),
            db.select({ count: count() }).from(recordings).where(inPrevWindow(recordings.createdAt)),
            db.select({ count: count() }).from(meetings)
                .where(and(sql`${meetings.startedAt} IS NOT NULL`, sql`${meetings.endedAt} IS NULL`))
        ]);

        const durationBuckets = [
            { label: '<15m', min: 0, max: 15, count: 0 },
            { label: '15–30m', min: 15, max: 30, count: 0 },
            { label: '30–60m', min: 30, max: 60, count: 0 },
            { label: '1–2h', min: 60, max: 120, count: 0 },
            { label: '2h+', min: 120, max: Infinity, count: 0 }
        ];
        for (const row of durationRows) {
            const m = Number(row.minutes) || 0;
            const bucket = durationBuckets.find(b => m >= b.min && m < b.max);
            if (bucket) bucket.count += 1;
        }

        const one = (rows) => Number(rows?.[0]?.count || 0);
        const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

        res.json({
            days,
            generatedAt: now.toISOString(),
            totals: {
                userTotals: one(userTotalRows),
                userNew: one(usersWindowRows),
                userNewPrev: one(usersPrevRows),
                meetings: one(meetingsWindowRows),
                meetingsPrev: one(meetingsPrevRows),
                messages: one(messagesWindowRows),
                messagesPrev: one(messagesPrevRows),
                recordings: one(recordingsWindowRows),
                recordingsPrev: one(recordingsPrevRows),
                activeNow: one(activeNowRows)
        },
        perDay: {
            meetings: meetingsPerDay.map(r => ({ day: dayKey(r.day), count: r.count })),
            users: usersPerDay.map(r => ({ day: dayKey(r.day), count: r.count })),
            messages: messagesPerDay.map(r => ({ day: dayKey(r.day), count: r.count }))
        },
        heatmap: heatmapRows,
        topHosts,
        durations: durationBuckets.map(({ label, count }) => ({ label, count })),
        providers: providerRows.map(r => ({ provider: r.provider || 'local', count: r.count })),
        reactions: reactionRows                      // [{ emoji, count }]
    });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/users', verifyToken, requireAdmin, async (req, res) => {
    try {
        const limit = parsePositiveInt(req.query.limit, 50, 100);
        const offset = parsePositiveInt(req.query.offset, 0, 100000);

        const [rows, totalRows] = await Promise.all([
            db.select({
                id: users.id,
                email: users.email,
                name: users.name,
                authProvider: users.authProvider,
                emailVerified: users.emailVerified,
                googleCalendarEmail: users.googleCalendarEmail,
                createdAt: users.createdAt,
                updatedAt: users.updatedAt
            })
            .from(users)
            .orderBy(desc(users.createdAt))
            .limit(limit)
            .offset(offset),
            db.select({ count: sql`count(*)` }).from(users)
        ]);

        const enriched = await Promise.all(rows.map(async (user) => {
            const [hostedRows, joinedRows] = await Promise.all([
                db.select({ count: sql`count(*)` }).from(meetings).where(eq(meetings.hostId, user.id)),
                db.select({ count: sql`count(*)` }).from(meetingParticipants).where(eq(meetingParticipants.userId, user.id))
            ]);

            return {
                ...user,
                hostedMeetingCount: countValue(hostedRows),
                joinedMeetingCount: countValue(joinedRows)
            };
        }));

        res.json({
            limit,
            offset,
            total: countValue(totalRows),
            users: enriched
        });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/meetings', verifyToken, requireAdmin, async (req, res) => {
    try {
        const limit = parsePositiveInt(req.query.limit, 50, 100);
        const offset = parsePositiveInt(req.query.offset, 0, 100000);
        const hostId = Number.parseInt(req.query.hostId, 10);
        const status = String(req.query.status || '').toLowerCase();
        const code = String(req.query.code || '').trim();
        const now = new Date();

        const conditions = [];
        if (code) conditions.push(eq(meetings.meetingCode, code));
        if (Number.isFinite(hostId)) conditions.push(eq(meetings.hostId, hostId));
        if (status === 'active') {
            conditions.push(and(sql`${meetings.startedAt} IS NOT NULL`, sql`${meetings.endedAt} IS NULL`));
        } else if (status === 'ended') {
            conditions.push(sql`${meetings.endedAt} IS NOT NULL`);
        } else if (status === 'scheduled') {
            conditions.push(and(sql`${meetings.scheduledTime} >= ${now}`, sql`${meetings.startedAt} IS NULL`));
        }

        const whereClause = compactWhere(conditions);
        const meetingQuery = db.select({
            id: meetings.id,
            hostId: meetings.hostId,
            title: meetings.title,
            meetingCode: meetings.meetingCode,
            scheduledTime: meetings.scheduledTime,
            startedAt: meetings.startedAt,
            endedAt: meetings.endedAt,
            isRecording: meetings.isRecording,
            createdAt: meetings.createdAt,
            updatedAt: meetings.updatedAt,
            hostName: users.name,
            hostEmail: users.email
        })
        .from(meetings)
        .leftJoin(users, eq(meetings.hostId, users.id));

        const countQuery = db.select({ count: sql`count(*)` }).from(meetings);
        const [rows, totalRows] = await Promise.all([
            (whereClause ? meetingQuery.where(whereClause) : meetingQuery)
                .orderBy(desc(meetings.createdAt))
                .limit(limit)
                .offset(offset),
            (whereClause ? countQuery.where(whereClause) : countQuery)
        ]);

        const enriched = await Promise.all(rows.map(async (meeting) => {
            const [participantRows, recordingRows, messageRows, auditRows] = await Promise.all([
                db.select({ count: sql`count(*)` }).from(meetingParticipants).where(eq(meetingParticipants.meetingId, meeting.id)),
                db.select({ count: sql`count(*)` }).from(recordings).where(eq(recordings.meetingId, meeting.id)),
                db.select({ count: sql`count(*)` }).from(messages).where(eq(messages.meetingId, meeting.id)),
                db.select({
                    id: meetingAuditLogs.id,
                    action: meetingAuditLogs.action,
                    actorName: meetingAuditLogs.actorName,
                    durationSeconds: meetingAuditLogs.durationSeconds,
                    occurredAt: meetingAuditLogs.occurredAt
                })
                .from(meetingAuditLogs)
                .where(eq(meetingAuditLogs.meetingId, meeting.id))
                .orderBy(desc(meetingAuditLogs.occurredAt))
                .limit(1)
            ]);

            return {
                ...meeting,
                durationSeconds: secondsBetween(meeting.startedAt, meeting.endedAt || (meeting.startedAt ? now : null)),
                participantCount: countValue(participantRows),
                recordingCount: countValue(recordingRows),
                messageCount: countValue(messageRows),
                latestAuditLog: auditRows[0] || null
            };
        }));

        res.json({
            limit,
            offset,
            total: countValue(totalRows),
            meetings: enriched
        });
    } catch (err) {
        console.error('Admin meetings error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/meetings/:id', verifyToken, requireAdmin, async (req, res) => {
    try {
        await ensureMeetingAuditSchema();

        const meetingId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(meetingId)) {
            return res.status(400).json({ error: 'Invalid meeting id' });
        }

        const rows = await db.select({
            id: meetings.id,
            hostId: meetings.hostId,
            title: meetings.title,
            meetingCode: meetings.meetingCode,
            scheduledTime: meetings.scheduledTime,
            startedAt: meetings.startedAt,
            endedAt: meetings.endedAt,
            isRecording: meetings.isRecording,
            createdAt: meetings.createdAt,
            updatedAt: meetings.updatedAt,
            hostName: users.name,
            hostEmail: users.email
        })
        .from(meetings)
        .leftJoin(users, eq(meetings.hostId, users.id))
        .where(eq(meetings.id, meetingId));

        const meeting = rows[0];
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const [participantRows, recordingRows, messageRows, auditRows] = await Promise.all([
            db.select({
                id: meetingParticipants.id,
                userId: meetingParticipants.userId,
                joinedAt: meetingParticipants.joinedAt,
                leftAt: meetingParticipants.leftAt
            })
            .from(meetingParticipants)
            .where(eq(meetingParticipants.meetingId, meetingId)),
            db.select({
                id: recordings.id,
                recordingUrl: recordings.recordingUrl,
                duration: recordings.duration,
                createdAt: recordings.createdAt
            })
            .from(recordings)
            .where(eq(recordings.meetingId, meetingId)),
            db.select({
                id: messages.id,
                userId: messages.userId,
                message: messages.message,
                createdAt: messages.createdAt
            })
            .from(messages)
            .where(eq(messages.meetingId, meetingId))
            .orderBy(desc(messages.createdAt))
            .limit(100),
            db.select().from(meetingAuditLogs)
                .where(eq(meetingAuditLogs.meetingId, meetingId))
                .orderBy(desc(meetingAuditLogs.occurredAt))
                .limit(200)
        ]);

        res.json({
            ...meeting,
            durationSeconds: secondsBetween(meeting.startedAt, meeting.endedAt || (meeting.startedAt ? new Date() : null)),
            participants: participantRows,
            recordings: recordingRows,
            messages: messageRows,
            auditLogs: auditRows.map((log) => ({
                ...log,
                details: parseAuditDetails(log.details)
            }))
        });
    } catch (err) {
        console.error('Admin meeting detail error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/audit-logs', verifyToken, requireAdmin, async (req, res) => {
    try {
        await ensureMeetingAuditSchema();

        const limit = parsePositiveInt(req.query.limit, 50, 200);
        const offset = parsePositiveInt(req.query.offset, 0, 100000);
        const meetingId = Number.parseInt(req.query.meetingId, 10);
        const userId = Number.parseInt(req.query.userId, 10);
        const meetingCode = String(req.query.meetingCode || '').trim();
        const action = String(req.query.action || '').trim();

        const conditions = [];
        if (Number.isFinite(meetingId)) conditions.push(eq(meetingAuditLogs.meetingId, meetingId));
        if (Number.isFinite(userId)) conditions.push(eq(meetingAuditLogs.userId, userId));
        if (meetingCode) conditions.push(eq(meetingAuditLogs.meetingCode, meetingCode));
        if (action) conditions.push(eq(meetingAuditLogs.action, action));

        const whereClause = compactWhere(conditions);
        const logQuery = db.select({
            id: meetingAuditLogs.id,
            meetingId: meetingAuditLogs.meetingId,
            meetingCode: meetingAuditLogs.meetingCode,
            userId: meetingAuditLogs.userId,
            actorName: meetingAuditLogs.actorName,
            action: meetingAuditLogs.action,
            details: meetingAuditLogs.details,
            durationSeconds: meetingAuditLogs.durationSeconds,
            occurredAt: meetingAuditLogs.occurredAt,
            createdAt: meetingAuditLogs.createdAt,
            meetingTitle: meetings.title,
            userEmail: users.email,
            userName: users.name
        })
        .from(meetingAuditLogs)
        .leftJoin(meetings, eq(meetingAuditLogs.meetingId, meetings.id))
        .leftJoin(users, eq(meetingAuditLogs.userId, users.id));

        const countQuery = db.select({ count: sql`count(*)` }).from(meetingAuditLogs);
        const [rows, totalRows] = await Promise.all([
            (whereClause ? logQuery.where(whereClause) : logQuery)
                .orderBy(desc(meetingAuditLogs.occurredAt))
                .limit(limit)
                .offset(offset),
            (whereClause ? countQuery.where(whereClause) : countQuery)
        ]);

        res.json({
            limit,
            offset,
            total: countValue(totalRows),
            auditLogs: rows.map((log) => ({
                ...log,
                details: parseAuditDetails(log.details)
            }))
        });
    } catch (err) {
        console.error('Admin audit logs error:', err);
        res.status(400).json({ error: err.message });
    }
});

// ============ MEETING ROUTES ============
app.post('/api/meetings', verifyToken, async (req, res) => {
    try {
        const { title, scheduledTime } = req.body;
        const meetingCode = Math.random().toString(36).substring(2, 11).toUpperCase();
        
        const result = await db.insert(meetings).values({
            hostId: req.userId,
            title: title || 'Meeting',
            meetingCode,
            scheduledTime: scheduledTime ? new Date(scheduledTime) : null
        }).returning();

        await recordMeetingAudit({
            meeting: result[0],
            userId: req.userId,
            action: scheduledTime ? 'meeting_scheduled' : 'meeting_created',
            details: {
                title: title || 'Meeting',
                scheduledTime: scheduledTime || null
            }
        });

        let calendar = { inserted: false, reason: 'not-scheduled' };
        if (result[0]?.scheduledTime) {
            calendar = await createGoogleCalendarEventForUser(req.userId, result[0]);
        }

        res.json({
            ...result[0],
            calendar
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings', verifyToken, async (req, res) => {
    try {
        const result = await db.select({
            id: meetings.id,
            hostId: meetings.hostId,
            title: meetings.title,
            meetingCode: meetings.meetingCode,
            scheduledTime: meetings.scheduledTime,
            startedAt: meetings.startedAt,
            endedAt: meetings.endedAt,
            createdAt: meetings.createdAt,
            hostName: users.name
        })
        .from(meetings)
        .leftJoin(users, eq(meetings.hostId, users.id))
        .where(
            or(
                eq(meetings.hostId, req.userId),
                inArray(meetings.id, 
                    db.select({ meetingId: meetingParticipants.meetingId })
                        .from(meetingParticipants)
                        .where(eq(meetingParticipants.userId, req.userId))
                )
            )
        )
        .orderBy(meetings.createdAt);

        const now = new Date();
        const upcomingMeetings = result.filter((meeting) => {
            if (meeting.endedAt) return false;
            if (!meeting.scheduledTime) return false;
            return new Date(meeting.scheduledTime) >= now;
        });

        res.json(upcomingMeetings);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/history', verifyToken, async (req, res) => {
    try {
        await ensureMeetingAuditSchema();

        const accessibleMeetings = await db.select({
            id: meetings.id,
            hostId: meetings.hostId,
            title: meetings.title,
            meetingCode: meetings.meetingCode,
            scheduledTime: meetings.scheduledTime,
            startedAt: meetings.startedAt,
            endedAt: meetings.endedAt,
            createdAt: meetings.createdAt,
            hostName: users.name
        })
        .from(meetings)
        .leftJoin(users, eq(meetings.hostId, users.id))
        .where(
            or(
                eq(meetings.hostId, req.userId),
                inArray(meetings.id,
                    db.select({ meetingId: meetingParticipants.meetingId })
                        .from(meetingParticipants)
                        .where(eq(meetingParticipants.userId, req.userId))
                )
            )
        )
        .orderBy(desc(meetings.createdAt));

        const now = new Date();
        const historyRows = accessibleMeetings.filter((meeting) => {
            if (meeting.startedAt || meeting.endedAt) return true;
            if (!meeting.scheduledTime) return true;
            return new Date(meeting.scheduledTime) < now;
        });

        const enriched = [];
        for (const meeting of historyRows) {
            const [logs, participantRows, recordingRows, messageRows] = await Promise.all([
                db.select().from(meetingAuditLogs)
                    .where(eq(meetingAuditLogs.meetingId, meeting.id))
                    .orderBy(desc(meetingAuditLogs.occurredAt)),
                db.select({ userId: meetingParticipants.userId })
                    .from(meetingParticipants)
                    .where(eq(meetingParticipants.meetingId, meeting.id)),
                db.select({ id: recordings.id, duration: recordings.duration })
                    .from(recordings)
                    .where(eq(recordings.meetingId, meeting.id)),
                db.select({ id: messages.id })
                    .from(messages)
                    .where(eq(messages.meetingId, meeting.id))
            ]);

            const meetingDurationSeconds = secondsBetween(
                meeting.startedAt,
                meeting.endedAt || (meeting.startedAt ? now : null)
            );
            const participantDurationSeconds = logs
                .filter((log) => log.action === 'participant_left' && Number.isFinite(Number(log.durationSeconds)))
                .reduce((total, log) => total + Number(log.durationSeconds || 0), 0);

            enriched.push({
                ...meeting,
                durationSeconds: meetingDurationSeconds,
                participantDurationSeconds,
                participantCount: new Set(participantRows.map((row) => row.userId).filter(Boolean)).size,
                recordingCount: recordingRows.length,
                recordingDurationSeconds: recordingRows.reduce((total, row) => total + Number(row.duration || 0), 0),
                messageCount: messageRows.length,
                auditLogs: logs.map((log) => ({
                    id: log.id,
                    userId: log.userId,
                    actorName: log.actorName,
                    action: log.action,
                    details: parseAuditDetails(log.details),
                    durationSeconds: log.durationSeconds,
                    occurredAt: log.occurredAt
                }))
            });
        }

        res.json(enriched);
    } catch (err) {
        console.error('Meeting history error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code', verifyToken, async (req, res) => {
    try {
        const result = await db.select({
            id: meetings.id,
            hostId: meetings.hostId,
            title: meetings.title,
            meetingCode: meetings.meetingCode,
            scheduledTime: meetings.scheduledTime,
            createdAt: meetings.createdAt,
            hostName: users.name
        })
        .from(meetings)
        .leftJoin(users, eq(meetings.hostId, users.id))
        .where(eq(meetings.meetingCode, req.params.code));
        
        if (result.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        res.json(result[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/join', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        const meetingId = meetingResult[0].id;
        
        // Check if already joined
        const existingResult = await db.select()
            .from(meetingParticipants)
            .where(
                and(
                    eq(meetingParticipants.meetingId, meetingId),
                    eq(meetingParticipants.userId, req.userId)
                )
            );
        
        if (existingResult.length === 0) {
            await db.insert(meetingParticipants).values({
                meetingId,
                userId: req.userId
            });
        } else {
            await db.update(meetingParticipants)
                .set({ joinedAt: new Date(), leftAt: null })
                .where(eq(meetingParticipants.id, existingResult[0].id));
        }

        await recordMeetingAudit({
            meeting: meetingResult[0],
            userId: req.userId,
            action: 'participant_registered',
            details: { source: 'join_endpoint' }
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/recordings/start', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const meeting = meetingResult[0];
        if (meeting.hostId !== req.userId) {
            return res.status(403).json({ error: 'Only host can start recording' });
        }

        await db.update(meetings)
            .set({ isRecording: true, updatedAt: new Date() })
            .where(eq(meetings.id, meeting.id));

        await recordMeetingAudit({
            meeting,
            userId: req.userId,
            action: 'recording_started',
            details: { source: 'host_control' }
        });

        res.json({ success: true, message: 'Recording started' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/recordings/stop', verifyToken, (req, res, next) => {
    uploadRecording.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Recording must be 300MB or smaller' });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No recording uploaded' });
        }

        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const meeting = meetingResult[0];
        if (meeting.hostId !== req.userId) {
            return res.status(403).json({ error: 'Only host can stop/save recording' });
        }

        const durationMs = Number(req.body.durationMs || 0);
        const durationSeconds = Number.isFinite(durationMs) && durationMs > 0
            ? Math.max(1, Math.round(durationMs / 1000))
            : null;

        const recordingUrl = `/api/meetings/${encodeURIComponent(req.params.code)}/recordings/files/${encodeURIComponent(req.file.filename)}`;
        const result = await db.insert(recordings).values({
            meetingId: meeting.id,
            recordingUrl,
            duration: durationSeconds
        }).returning();

        const saveToGoogleDrive = req.body.saveToGoogleDrive === '1' || req.body.saveToGoogleDrive === 'true';
        let googleDriveSync = { uploaded: false, reason: 'disabled' };
        if (saveToGoogleDrive) {
            googleDriveSync = await uploadRecordingToGoogleDrive(
                req.userId,
                req.params.code,
                req.file.path,
                req.file.filename,
                durationSeconds
            );
        }

        const githubSync = await uploadRecordingToLinkedGitHub(
            req.userId,
            req.params.code,
            req.file.path,
            req.file.filename,
            durationSeconds
        );

        await db.update(meetings)
            .set({ isRecording: false, updatedAt: new Date() })
            .where(eq(meetings.id, meeting.id));

        await recordMeetingAudit({
            meeting,
            userId: req.userId,
            action: 'recording_saved',
            durationSeconds,
            details: {
                recordingUrl,
                googleDriveUploaded: !!googleDriveSync?.uploaded,
                githubUploaded: !!githubSync?.uploaded
            }
        });

        res.json({
            success: true,
            recording: result[0],
            googleDriveSync,
            githubSync
        });
    } catch (err) {
        console.error('Recording stop/save error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code/recordings', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const meeting = meetingResult[0];
        const participantRows = await db.select({ id: meetingParticipants.id })
            .from(meetingParticipants)
            .where(and(
                eq(meetingParticipants.meetingId, meeting.id),
                eq(meetingParticipants.userId, req.userId)
            ));

        const hasAccess = meeting.hostId === req.userId || participantRows.length > 0;
        if (!hasAccess) {
            return res.status(403).json({ error: 'You do not have access to this meeting recordings' });
        }

        const rows = await db.select().from(recordings).where(eq(recordings.meetingId, meeting.id));
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code/recordings/files/:fileName', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const meeting = meetingResult[0];
        const participantRows = await db.select({ id: meetingParticipants.id })
            .from(meetingParticipants)
            .where(and(
                eq(meetingParticipants.meetingId, meeting.id),
                eq(meetingParticipants.userId, req.userId)
            ));

        const hasAccess = meeting.hostId === req.userId || participantRows.length > 0;
        if (!hasAccess) {
            return res.status(403).json({ error: 'You do not have access to this recording' });
        }

        const filePath = path.join(getRoomRecordingDir(req.params.code), req.params.fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Recording file not found' });
        }

        res.setHeader('Content-Type', 'video/webm');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.code}-recording.webm"`);
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ CHAT ROUTES ============
app.post('/api/meetings/:code/messages', verifyToken, async (req, res) => {
    try {
        const { message } = req.body;
        const roomCode = req.params.code;
        const hostOk = await isHostForRoom(req.userId, roomCode);

        if (roomChatLocked.get(roomCode) && !hostOk) {
            return res.status(403).json({ error: 'Chat is locked for this room' });
        }

        const bannedSet = roomChatBanned.get(roomCode);
        if (bannedSet && bannedSet.has(req.userId)) {
            return res.status(403).json({ error: 'Your chat is disabled in this room' });
        }
        
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, roomCode));
        
        if (meetingResult.length > 0) {
            await db.insert(messages).values({
                meetingId: meetingResult[0].id,
                userId: req.userId,
                message
            });
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/attachments', verifyToken, (req, res, next) => {
    uploadAttachment.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File must be 10MB or smaller' });
        }
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const roomCode = req.params.code;
        const hostOk = await isHostForRoom(req.userId, roomCode);

        if (roomChatLocked.get(roomCode) && !hostOk) {
            return res.status(403).json({ error: 'Chat is locked for this room' });
        }

        const bannedSet = roomChatBanned.get(roomCode);
        if (bannedSet && bannedSet.has(req.userId)) {
            return res.status(403).json({ error: 'Your chat is disabled in this room' });
        }

        try {
            const userResult = await db.select({ name: users.name }).from(users).where(eq(users.id, req.userId));
            if (!userResult || userResult.length === 0) {
                return res.status(400).json({ error: 'User not found' });
            }

            const attachmentMessage = buildAttachmentMessage(roomCode, req.userId, userResult[0]?.name, req.file, {
                mimeType: req.body.mimeType,
                size: req.body.fileSize,
                originalName: req.body.originalName,
                originalNameEncrypted: req.body.originalNameEncrypted
            });
            const roomMessages = roomRuntimeMessages.get(roomCode) || [];
            roomMessages.push(attachmentMessage);
            roomRuntimeMessages.set(roomCode, roomMessages);

            io.to(roomCode).emit('receive-message', attachmentMessage);
            res.json(attachmentMessage);
        } catch (dbErr) {
            console.error('Attachment processing error:', dbErr);
            res.status(500).json({ error: 'Failed to process attachment' });
        }
    } catch (err) {
        console.error('Attachment route error:', err);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code/attachments/:fileName', verifyToken, (req, res) => {
    try {
        const roomCode = req.params.code;
        const fileName = req.params.fileName;
        const filePath = path.join(getRoomAttachmentDir(roomCode), fileName);

        console.log('Download request:', { roomCode, fileName, filePath });

        if (!fs.existsSync(filePath)) {
            console.log('File not found:', filePath);
            return res.status(404).json({ error: 'Attachment not found' });
        }

        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            console.log('Not a file:', filePath);
            return res.status(404).json({ error: 'Invalid attachment' });
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.sendFile(filePath);
    } catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Failed to download attachment: ' + err.message });
    }
});

app.get('/api/meetings/:code/messages', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));

        let persistedMessages = [];
        if (meetingResult.length > 0) {
            persistedMessages = await db.select({
                id: messages.id,
                meetingId: messages.meetingId,
                userId: messages.userId,
                message: messages.message,
                name: users.name,
                createdAt: messages.createdAt,
                kind: sql`'text'`
            })
            .from(messages)
            .leftJoin(users, eq(messages.userId, users.id))
            .where(eq(messages.meetingId, meetingResult[0].id))
            .orderBy(messages.createdAt);
        }

        const runtimeMessages = roomRuntimeMessages.get(req.params.code) || [];
        const combinedMessages = [...persistedMessages, ...runtimeMessages]
            .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));

        res.json(combinedMessages);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============ ROOM INFO ============
app.get('/api/meetings/:code/host-check', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select({ hostId: meetings.hostId })
            .from(meetings)
            .where(eq(meetings.meetingCode, req.params.code));

        if (meetingResult.length > 0) {
            // Scheduled meeting - check if user is the host
            res.json({ isHost: meetingResult[0].hostId === req.userId });
        } else {
            // Instant/ad-hoc meeting - check if user is the first joiner
            const instantHost = instantRoomHosts.get(req.params.code);
            res.json({ isHost: instantHost === req.userId });
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/2fa/setup', verifyToken, async (req, res) => {
    try{
        const secret = speakeasy.generateSecret({ 
            name: `Sup! (${req.user?.email})`,
            length: 32
        });

        const qrCode = await QRCode.toDataURL(secret.otpauth_url);

        await db.insert(userTwoFactor).values({
            userId: req.userId,
            secret: secret.base32,
            backupCodes: JSON.stringify(generateBackupCodes(10)),
            enabled: false
        }).onConflictDoUpdate({
            target: userTwoFactor.userId,
            set: { secret: secret.base32}
    });

    res.json({
        qrCode,
        secret: secret.base32,
        backupCodes: JSON.parse(generateBackupCodes(10))
    });
}catch(err){
    res.status(400).json({ error: err.message });
}
});

app.post('/api/2fa/verify', verifyToken, async (req, res) => {
    try{
        const { token } = req.body;
        const twoFa = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, req.userId));

        const verified = speakeasy.totp.verify({
            secret: twoFa[0].secret,
            token,
            window: 2
        });

        if (!verified) return res.status(401).json({ error: 'Invalid 2FA token' });

        await db.update(userTwoFactor).set({ enabled: true }).where(eq(userTwoFactor.userId, req.userId));
        res.json({ success: true });
    }catch(err){
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/2fa/disable', verifyToken, async (req, res) => {
    try{
        await db.update(userTwoFactor).set({ enabled: false, secret: null, backupCodes: null }).where(eq(userTwoFactor.userId, req.userId));
        res.json({ success: true });
    }catch(err){
        res.status(400).json({ error: err.message });
    }
});

function generateBackupCodes(count=10) {
    const codes = [];
    for(let i=0; i<count; i++){
        codes.push(randomUUID().split('-')[0]);
    }
    return JSON.stringify(codes);
}

app.post('/api/meetings/:code/waiting-room/request', verifyToken, async (req, res) => {
    try{
        const { code } = req.params;

        await db.insert(waitingRoom).values({
            meetingCode: code,
            userId: req.userId,
            status: 'awaiting'
        });

        const meeting = await db.select({ hostId: meetings.hostId }).from(meetings).where(eq(meetings.meetingCode, code));
        io.to(code).emit('userWaiting', { userId: req.userId});
        res.json({ status: 'waiting' });
    }catch(err){
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/waiting-room/approve', verifyToken, async (req, res) => {
    try{
        const { code } = req.params;
        const { userId } = req.body;

        const isHost = await isHostForRoom(req.userId, code);
        if (!isHost) return res.status(403).json({ error: 'Not Host' });

        await db.update(meetingWaitingRoom)
            .set({ status: 'approved' })
            .where(
                and(
                    eq(meetingWaitingRoom.meetingCode, code),
                    eq(meetingWaitingRoom.userId, userId)
                )
            );
        io.to(code).emit('userApproved', { userId });
        res.json({ success: true });
    }catch(err){
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/poll', verifyToken, async (req, res) => {
    try {
        const { code } = req.params;
        const { question, options } = req.body;

        const isHost = await isHostForRoom(req.userId, code);
        if (!isHost) return res.status(403).json({ error: 'Not host' });

        const result = await db.insert(polls).values({
            meetingCode: code,
            hostId: req.userId,
            question,
            options: JSON.stringify(options)
        }).returning();

        io.to(code).emit('newPoll', {
            pollId: result[0].id,
            question,
            options
        });

        res.json(result[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/polls/:pollId/vote', verifyToken, async (req, res) => {
    try {
        const { optionIndex } = req.body;

        const result = await db.insert(pollResponses).values({
            pollId: req.params.pollId,
            userId: req.userId,
            selectedOptionIndex: optionIndex
        }).returning();

        // Get updated results
        const responses = await db.select().from(pollResponses).where(eq(pollResponses.pollId, req.params.pollId));
        const aggregated = aggregatePollResults(responses);

        io.emit('pollUpdate', { pollId: req.params.pollId, results: aggregated });
        res.json(result[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

function aggregatePollResults(responses) {
    const counts = {};
    responses.forEach(r => {
        counts[r.selectedOptionIndex] = (counts[r.selectedOptionIndex] || 0) + 1;
    });
    return counts;
}

app.get('/api/rooms/:code/participants', verifyToken, (req, res) => {
    const roomCode = req.params.code;
    const room = io.sockets.adapter.rooms.get(roomCode);
    const count = room ? room.size : 0;

    const participants = [];
    if (room) {
        for (const socketId of room) {
            const userData = connectedUsers[socketId];
            if (userData) {
                participants.push({ socketId, userId: userData.userId, name: userData.name });
            }
        }
    }

    res.json({ count, participants });
});

app.get('/join/:code', (req, res) => {
    if (/-BR-/i.test(req.params.code || '')) {
        return res.status(403).send('Breakout rooms cannot be joined with a code.');
    }

    res.redirect(`/meeting.html?room=${encodeURIComponent(req.params.code)}`);
});

const connectedUsers = {};

io.on('connection', (socket) => {
    socket.on('reaction', (data) => {
        const { meetingCode,emoji,userId } = data;

        io.to(meetingCode).emit('reaction', {
            userId,
            emoji,
            timestamp: new Date()
        });

        db.insert(meetingReactions).values({
            meetingCode,
            userId,
            emoji
        });
    });

    socket.on('raiseHand', (data) => {
        const { meetingCode, userId } = data;
        io.to(meetingCode).emit('raiseHand', {userId});

        db.insert(raisedHands).values({
            meetingCode,
            userId,
            raisedAt: new Date()
        });
    });

    socket.on('lowerHand', (data) => {
        const { meetingCode, userId } = data;
        io.to(meetingCode).emit('lowerHand', {userId});
    });

    socket.on('join-room', async (room, userId, userName, ack) => {
        const roomBefore = io.sockets.adapter.rooms.get(room);
        const isFirstJoiner = !roomBefore || roomBefore.size === 0;
        const joinedAt = new Date();
        
        cancelRoomCleanup(room);
        socket.join(room);
        
        let isHost = false;
        let meeting = await getMeetingByCode(room);
        if (meeting) {
            isHost = meeting.hostId === userId;
        } else if (isFirstJoiner) {
            // Ad-hoc meeting, first joiner is host
            instantRoomHosts.set(room, userId);
            isHost = true;
            meeting = await ensureInstantMeeting(room, userId);
        } else {
            // Arriving later at an instant meeting
            isHost = instantRoomHosts.get(room) === userId;
            meeting = await getMeetingByCode(room);
        }

        connectedUsers[socket.id] = {
            userId,
            room,
            name: userName || 'User',
            joinedAt,
            meetingId: meeting?.id || null
        };

        const existingParticipants = Array.from(roomBefore || [])
            .map((socketId) => {
                const participant = connectedUsers[socketId];
                if (!participant || participant.room !== room) return null;
                return {
                    socketId,
                    userId: participant.userId,
                    name: participant.name || 'User'
                };
            })
            .filter(Boolean);

        if (existingParticipants.length > 0) {
            socket.emit('room-participants', existingParticipants);
        }

        socket.to(room).emit('user-joined', socket.id, userName || 'User');
        if (typeof ack === 'function') ack({ isHost });

        if (meeting) {
            const shouldMarkStarted = !meeting.startedAt || !!meeting.endedAt;

            try {
                await db.update(meetings)
                    .set({ startedAt: meeting.startedAt || joinedAt, endedAt: null, updatedAt: joinedAt })
                    .where(eq(meetings.id, meeting.id));

                if (userId) {
                    const existingParticipant = await db.select()
                        .from(meetingParticipants)
                        .where(and(
                            eq(meetingParticipants.meetingId, meeting.id),
                            eq(meetingParticipants.userId, userId)
                        ));

                    if (existingParticipant.length === 0) {
                        await db.insert(meetingParticipants).values({
                            meetingId: meeting.id,
                            userId,
                            joinedAt
                        });
                    } else {
                        await db.update(meetingParticipants)
                            .set({ joinedAt, leftAt: null })
                            .where(eq(meetingParticipants.id, existingParticipant[0].id));
                    }
                }

                if (shouldMarkStarted) {
                    await recordMeetingAudit({
                        meeting,
                        userId,
                        actorName: userName || 'User',
                        action: 'meeting_started',
                        details: { source: isFirstJoiner ? 'first_joiner' : 'rejoin' },
                        occurredAt: joinedAt
                    });
                }

                await recordMeetingAudit({
                    meeting,
                    userId,
                    actorName: userName || 'User',
                    action: 'participant_joined',
                    details: { socketId: socket.id, host: isHost },
                    occurredAt: joinedAt
                });
            } catch (err) {
                console.error('Failed to record meeting join:', err);
            }
        }
    });

    socket.on('signal', (data) => {
        const actor = connectedUsers[socket.id];
        io.to(data.to).emit('signal', {
            from: socket.id,
            fromName: actor?.name || 'User',
            signal: data.signal
        });
    });

    socket.on('send-message', async (data) => {
        const actor = connectedUsers[socket.id];
        if (!actor || actor.room !== data.room) return;

        const banned = roomChatBanned.get(data.room);
        if (banned && banned.has(actor.userId)) return;

        if (roomChatLocked.get(data.room)) {
            const hostOk = await isHostForRoom(actor.userId, data.room);
            if (!hostOk) return;
        }

        io.to(data.room).emit('receive-message', {
            from: socket.id,
            userId: actor.userId,
            name: actor.name || 'User',
            kind: 'text',
            message: data.message,
            createdAt: new Date().toISOString()
        });
    });

    socket.on('camera-state', (data) => {
        socket.to(data.room).emit('camera-state', {
            from: socket.id,
            isOff: !!data.isOff
        });
    });


    socket.on('host-control', async ({ room, targetId, action }) => {
        const actor = connectedUsers[socket.id];
        const target = connectedUsers[targetId];

        if (!actor || actor.room !== room) return;
        if (!target || target.room !== room) return;
        if (targetId === socket.id) return;

        const allowed = ['mute-audio', 'mute-video', 'remove', 'disable-chat', 'enable-chat'];
        if (!allowed.includes(action)) return;

        const hostOk = await isHostForRoom(actor.userId, room);
        if (!hostOk) return;

        if (action === 'disable-chat') {
            const bannedSet = roomChatBanned.get(room) || new Set();
            bannedSet.add(target.userId);
            roomChatBanned.set(room, bannedSet);
        } else if (action === 'enable-chat') {
            roomChatBanned.get(room)?.delete(target.userId);
        }

        io.to(targetId).emit('host-control', { action, byName: actor.name || 'Host' });
    });

    socket.on('host-room-control', async ({room,action}) => {
        const actor = connectedUsers[socket.id];
        if (!actor || actor.room !== room) return;

        const allowed = ['lock-chat', 'unlock-chat'];
        if (!allowed.includes(action)) return;

        const hostOk = await isHostForRoom(actor.userId, room);
        if (!hostOk) return;

        if (action === 'lock-chat') {
            roomChatLocked.set(room, true);
        } else {
            roomChatLocked.delete(room);
        }
        socket.to(room).emit('host-room-control', { action, byName: actor.name || 'Host' });
    });

    // E2EE: relay a participant's public key to the rest of the room
    socket.on('e2ee-public-key', ({ room, pubKey }) => {
        const actor = connectedUsers[socket.id];
        if (!actor || actor.room !== room) return;
        socket.to(room).emit('e2ee-public-key', { from: socket.id, pubKey });
    });

    // E2EE: relay the host's wrapped room-key offer to a specific recipient
    socket.on('e2ee-key-offer', ({ to, wrappedKey, iv, hostPubKey }) => {
        const actor = connectedUsers[socket.id];
        if (!actor) return;
        io.to(to).emit('e2ee-key-offer', { from: socket.id, wrappedKey, iv, hostPubKey });
    });

    socket.on('disconnect', async () => {
        const userData = connectedUsers[socket.id];
        if (userData) {
            io.to(userData.room).emit('user-left', socket.id);
            const leftAt = new Date();
            const durationSeconds = secondsBetween(userData.joinedAt, leftAt);

            try {
                const meeting = userData.meetingId
                    ? (await db.select().from(meetings).where(eq(meetings.id, userData.meetingId)))[0]
                    : await getMeetingByCode(userData.room);

                if (meeting && userData.userId) {
                    await db.update(meetingParticipants)
                        .set({ leftAt })
                        .where(and(
                            eq(meetingParticipants.meetingId, meeting.id),
                            eq(meetingParticipants.userId, userData.userId)
                        ));
                }

                if (meeting) {
                    await recordMeetingAudit({
                        meeting,
                        userId: userData.userId,
                        actorName: userData.name || 'User',
                        action: 'participant_left',
                        details: { socketId: socket.id },
                        durationSeconds,
                        occurredAt: leftAt
                    });
                }
            } catch (err) {
                console.error('Failed to record meeting leave:', err);
            }

            const room = io.sockets.adapter.rooms.get(userData.room);
            if (!room || room.size === 0) {
                scheduleRoomCleanup(userData.room);
            }
        }
        delete connectedUsers[socket.id];
    });
});

const BASE_PORT = Number(process.env.PORT || 3000);
const MAX_PORT_RETRIES = 10;

function startServer(port, attempt = 0) {
    server.listen(port, () => {
        console.log(`listening on *:${port}`);
    });

    server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES) {
            const nextPort = port + 1;
            console.warn(`Port ${port} is in use, retrying on ${nextPort}...`);
            setTimeout(() => startServer(nextPort, attempt + 1), 100);
            return;
        }

        throw err;
    });
}

startServer(BASE_PORT);

ensureMeetingAuditSchema().catch((err) => {
    console.error('Meeting audit schema check failed:', err);
    return false;
});
