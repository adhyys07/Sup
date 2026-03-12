const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = 'your-secret-key-change-this';

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
        
        const result = await pool.query(
            'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
            [email, hashedPassword, name]
        );
        
        const token = jwt.sign({ id: result.rows[0].id }, JWT_SECRET);
        res.json({ token, user: result.rows[0] });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
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
        const result = await pool.query('SELECT id, email, name, bio, avatar FROM users WHERE id = $1', [req.userId]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/user/profile', verifyToken, async (req, res) => {
    try {
        const { name, bio, avatar } = req.body;
        const result = await pool.query(
            'UPDATE users SET name = $1, bio = $2, avatar = $3 WHERE id = $4 RETURNING id, email, name, bio, avatar',
            [name, bio, avatar, req.userId]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============ MEETING ROUTES ============
app.post('/api/meetings', verifyToken, async (req, res) => {
    try {
        const { title, scheduledTime } = req.body;
        const meetingCode = Math.random().toString(36).substring(2, 11).toUpperCase();
        
        const result = await pool.query(
            'INSERT INTO meetings (host_id, title, meeting_code, scheduled_time) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.userId, title, meetingCode, scheduledTime]
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT m.*, u.name as host_name FROM meetings m JOIN users u ON m.host_id = u.id WHERE m.host_id = $1 OR m.id IN (SELECT meeting_id FROM meeting_participants WHERE user_id = $1) ORDER BY m.created_at DESC',
            [req.userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT m.*, u.name as host_name FROM meetings m JOIN users u ON m.host_id = u.id WHERE m.meeting_code = $1',
            [req.params.code]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/meetings/:code/join', verifyToken, async (req, res) => {
    try {
        const meetingResult = await pool.query('SELECT id FROM meetings WHERE meeting_code = $1', [req.params.code]);
        
        if (meetingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        const meetingId = meetingResult.rows[0].id;
        
        // Check if already joined
        const existingResult = await pool.query(
            'SELECT * FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
            [meetingId, req.userId]
        );
        
        if (existingResult.rows.length === 0) {
            await pool.query(
                'INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2)',
                [meetingId, req.userId]
            );
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
        const meetingResult = await pool.query('SELECT id FROM meetings WHERE meeting_code = $1', [req.params.code]);
        
        if (meetingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        const result = await pool.query(
            'INSERT INTO messages (meeting_id, user_id, message) VALUES ($1, $2, $3) RETURNING m.*, u.name FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $4',
            [meetingResult.rows[0].id, req.userId, message, result.rows[0].id]
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/meetings/:code/messages', verifyToken, async (req, res) => {
    try {
        const meetingResult = await pool.query('SELECT id FROM meetings WHERE meeting_code = $1', [req.params.code]);
        
        if (meetingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        const result = await pool.query(
            'SELECT m.*, u.name FROM messages m JOIN users u ON m.user_id = u.id WHERE m.meeting_id = $1 ORDER BY m.created_at ASC',
            [meetingResult.rows[0].id]
        );
        
        res.json(result.rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ============ SOCKET.IO EVENTS ============
const connectedUsers = {};

io.on('connection', (socket) => {
    socket.on('join-room', (room, userId) => {
        socket.join(room);
        connectedUsers[socket.id] = { userId, room };
        socket.to(room).emit('user-joined', socket.id);
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

    socket.on('disconnect', () => {
        const userData = connectedUsers[socket.id];
        if (userData) {
            io.to(userData.room).emit('user-left', socket.id);
        }
        delete connectedUsers[socket.id];
    });
});

server.listen(3000, () => {
    console.log('listening on *:3000');
});