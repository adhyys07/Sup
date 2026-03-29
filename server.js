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
import { randomUUID, randomBytes } from 'crypto';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import nodemailer from 'nodemailer';
import 'dotenv/config';
import { db } from './db.js';
import { users, meetings, meetingParticipants, messages, userTwoFactor, meetingReactions, raisedHands, meetingWaitingRoom, oauthConnections } from './schema.js';
import { eq, or, and, inArray, sql } from 'drizzle-orm';
import speakeasy from 'speakeasy';
import ratelimit from 'express-rate-limit';
import { timestamp } from 'drizzle-orm/mysql-core';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Middleware
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);
app.use(passport.initialize());
app.use(express.static('public'));

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TEMP_ATTACHMENTS_DIR = path.join(process.cwd(), 'temp', 'meeting-attachments');
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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

// Helper function to send verification email
async function sendVerificationEmail(email, name, token) {
    const verificationUrl = `${BASE_URL}/verify-email?token=${token}`;
    const mailOptions = {
        from: process.env.EMAIL_USER || 'noreply@sup.app',
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
        await emailTransporter.sendMail(mailOptions);
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
            await db.update(meetings)
                .set({ endedAt: new Date(), updatedAt: new Date() })
                .where(eq(meetings.meetingCode, roomCode));
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
// ============ PASSPORT CONFIG ============
async function findOrCreateOAuthUser(profile, provider, linkingInfo = null) {
    const providerId = String(profile.id);
    const email = profile.emails?.[0]?.value || null;
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
                    avatar: profile.photos?.[0]?.value || null,
                    updatedAt: new Date()
                })
                .where(eq(oauthConnections.id, oauthRow.id));

            const linkedUser = await db.select().from(users).where(eq(users.id, oauthRow.userId));
            if (linkedUser.length > 0) return linkedUser[0];
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
                        avatar: profile.photos?.[0]?.value || null,
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
                    avatar: profile.photos?.[0]?.value || null
                });
            }
            
            return linkedUser[0];
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
                    avatar: profile.photos?.[0]?.value || null,
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
                avatar: profile.photos?.[0]?.value || null
            });
        }

        return existingUser;
    }

    // New local user record cannot be created without email.
    if (!email) {
        throw new Error('No email from provider. Make your GitHub email public or link GitHub from profile settings first.');
    }

    // Create new user
    const result = await db.insert(users).values({
        email,
        name: profile.displayName || email,
        avatar: profile.photos?.[0]?.value || null,
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
            avatar: profile.photos?.[0]?.value || null
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
        scope: ['profile', 'email', GOOGLE_CALENDAR_SCOPE],
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
        scope: ['user:email'],
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

            const user = await findOrCreateOAuthUser(profile, 'github', linkingInfo);
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
            scope: ['profile', 'email', GOOGLE_CALENDAR_SCOPE],
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

app.get('/auth/github', passport.authenticate('github', { session: false, scope: ['user:email'] }));

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

        if (!emailSent && process.env.EMAIL_USER) {
            // If email fails to send and email is configured, delete the user
            await db.delete(users).where(eq(users.id, result[0].id));
            return res.status(500).json({ error: 'Failed to send verification email. Please try again.' });
        }

        res.status(201).json({ 
            message: 'Account created! Please check your email to verify your address.',
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

        res.json({
            id: result[0].id,
            email: result[0].email,
            name: result[0].name,
            bio: result[0].bio,
            avatar: result[0].avatar,
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
        githubAuthUrl.searchParams.append('scope', 'user:email');
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
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
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
        
        cancelRoomCleanup(room);
        socket.join(room);
        connectedUsers[socket.id] = { userId, room, name: userName || 'User' };
        
        let isHost = false;
        // Check DB first for scheduled meetings
        const dbMeeting = await db.select({ hostId: meetings.hostId }).from(meetings).where(eq(meetings.meetingCode, room));
        if (dbMeeting.length > 0) {
            isHost = dbMeeting[0].hostId === userId;
        } else if (isFirstJoiner) {
            // Ad-hoc meeting, first joiner is host
            instantRoomHosts.set(room, userId);
            isHost = true;
        } else {
            // Arriving later at an instant meeting
            isHost = instantRoomHosts.get(room) === userId;
        }
        
        socket.to(room).emit('user-joined', socket.id, userName);
        if (typeof ack === 'function') ack({ isHost });

        db.update(meetings)
            .set({ startedAt: new Date(), endedAt: null, updatedAt: new Date() })
            .where(eq(meetings.meetingCode, room))
            .catch((err) => {
                console.error('Failed to mark meeting started:', err);
            });
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
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

    socket.on('disconnect', () => {
        const userData = connectedUsers[socket.id];
        if (userData) {
            io.to(userData.room).emit('user-left', socket.id);
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