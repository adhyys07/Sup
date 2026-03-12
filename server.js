import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import 'dotenv/config';
import { db } from './db.js';
import { users, meetings, meetingParticipants, messages } from './schema.js';
import { eq, or, and, inArray } from 'drizzle-orm';

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

// ============ PASSPORT CONFIG ============
async function findOrCreateOAuthUser(profile, provider) {
    const email = profile.emails?.[0]?.value;
    if (!email) throw new Error('No email from provider');

    const existing = await db.select().from(users).where(eq(users.email, email));

    if (existing.length > 0) {
        return existing[0];
    }

    const result = await db.insert(users).values({
        email,
        name: profile.displayName || email,
        avatar: profile.photos?.[0]?.value || null,
        authProvider: provider,
        authProviderId: profile.id
    }).returning();

    return result[0];
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`,
        scope: ['profile', 'email'],
        proxy: true
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const user = await findOrCreateOAuthUser(profile, 'google');
            done(null, user);
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
        scope: ['user:email']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const user = await findOrCreateOAuthUser(profile, 'github');
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
        res.redirect(`/auth-success.html?token=${token}`);
    }
);

app.get('/auth/github', passport.authenticate('github', { session: false, scope: ['user:email'] }));

app.get('/auth/github/callback',
    passport.authenticate('github', { session: false, failureRedirect: '/' }),
    (req, res) => {
        const token = jwt.sign({ id: req.user.id }, JWT_SECRET);
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
app.post('/api/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await db.insert(users).values({
            email,
            password: hashedPassword,
            name
        }).returning({ id: users.id, email: users.email, name: users.name });
        
        const token = jwt.sign({ id: result[0].id }, JWT_SECRET);
        res.json({ token, user: result[0] });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await db.select().from(users).where(eq(users.email, email));
        
        if (result.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ id: user.id }, JWT_SECRET);
        res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
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
            avatar: users.avatar
        }).from(users).where(eq(users.id, req.userId));
        
        res.json(result[0]);
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
        
        res.json(result[0]);
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
        
        res.json(result);
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
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        await db.insert(messages).values({
            meetingId: meetingResult[0].id,
            userId: req.userId,
            message
        });
        
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code/messages', verifyToken, async (req, res) => {
    try {
        const meetingResult = await db.select().from(meetings).where(eq(meetings.meetingCode, req.params.code));
        
        if (meetingResult.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        const result = await db.select({
            id: messages.id,
            meetingId: messages.meetingId,
            userId: messages.userId,
            message: messages.message,
            name: users.name,
            createdAt: messages.createdAt
        })
        .from(messages)
        .leftJoin(users, eq(messages.userId, users.id))
        .where(eq(messages.meetingId, meetingResult[0].id))
        .orderBy(messages.createdAt);
        
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============ ROOM INFO ============
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
    res.redirect(`/meeting.html?room=${encodeURIComponent(req.params.code)}`);
});

const connectedUsers = {};

io.on('connection', (socket) => {
    socket.on('join-room', (room, userId, userName) => {
        socket.join(room);
        connectedUsers[socket.id] = { userId, room, name: userName || 'User' };
        socket.to(room).emit('user-joined', socket.id, userName);
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('send-message', (data) => {
        io.to(data.room).emit('receive-message', {
            from: socket.id,
            userId: connectedUsers[socket.id]?.userId,
            message: data.message,
            timestamp: new Date()
        });
    });

    socket.on('camera-state', (data) => {
        socket.to(data.room).emit('camera-state', {
            from: socket.id,
            isOff: !!data.isOff
        });
    });

    socket.on('disconnect', () => {
        const userData = connectedUsers[socket.id];
        if (userData) {
            io.to(userData.room).emit('user-left', socket.id);
        }
        delete connectedUsers[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
});