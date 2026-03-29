import { sql } from 'drizzle-orm';
import { pgTable, serial, varchar, text, boolean, timestamp, integer, foreignKey, unique, index, uuid, bigint } from 'drizzle-orm/pg-core';

// Users table
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    password: varchar('password', { length: 255 }),
    name: varchar('name', { length: 255 }).notNull(),
    bio: text('bio'),
    avatar: varchar('avatar', { length: 500 }),
    authProvider: varchar('auth_provider', { length: 50 }).default('local'),
    authProviderId: varchar('auth_provider_id', { length: 255 }),
    googleCalendarEmail: varchar('google_calendar_email', { length: 255 }),
    googleCalendarRefreshToken: text('google_calendar_refresh_token'),
    emailVerified: boolean('email_verified').default(false),
    emailVerificationToken: varchar('email_verification_token', { length: 255 }),
    emailVerificationTokenExpires: timestamp('email_verification_token_expires'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

// Meetings table
export const meetings = pgTable('meetings', {
    id: serial('id').primaryKey(),
    hostId: integer('host_id').notNull().references(() => users.id),
    title: varchar('title', { length: 255 }),
    meetingCode: varchar('meeting_code', { length: 50 }).notNull().unique(),
    scheduledTime: timestamp('scheduled_time'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    isRecording: boolean('is_recording').default(false),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

// User OAuth Connections - track multiple OAuth providers per user
export const oauthConnections = pgTable('oauth_connections', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 50 }).notNull(), // 'google', 'github'
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    displayName: varchar('display_name', { length: 255 }),
    avatar: varchar('avatar', { length: 500 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

// User Two Factor
export const userTwoFactor = pgTable('user_two_factor', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    enabled: boolean('enabled').default(false),
    createdAt: timestamp('created_at').defaultNow(),
});

export const userPreferences = pgTable('user_preferences', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    theme: varchar('theme', { length: 50 }).default('auto'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

export const meetingReactions = pgTable('meeting_reactions', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    userId: integer('user_id').references(() => users.id),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});
// Meeting participants table
export const meetingParticipants = pgTable('meeting_participants', {
    id: serial('id').primaryKey(),
    meetingId: integer('meeting_id').notNull().references(() => meetings.id),
    userId: integer('user_id').notNull().references(() => users.id),
    joinedAt: timestamp('joined_at').defaultNow(),
    leftAt: timestamp('left_at'),
}, (table) => ({
    uniqueConstraint: unique().on(table.meetingId, table.userId)
}));

// Messages table
export const messages = pgTable('messages', {
    id: serial('id').primaryKey(),
    meetingId: integer('meeting_id').notNull().references(() => meetings.id),
    userId: integer('user_id').notNull().references(() => users.id),
    message: text('message').notNull(),
    createdAt: timestamp('created_at').defaultNow()
});

// Recordings table
export const recordings = pgTable('recordings', {
    id: serial('id').primaryKey(),
    meetingId: integer('meeting_id').notNull().references(() => meetings.id),
    recordingUrl: varchar('recording_url', { length: 500 }),
    duration: integer('duration'),
    createdAt: timestamp('created_at').defaultNow()
});

export const raisedHands = pgTable('raised_hands', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    userId: integer('user_id').references(() => users.id),
    raisedAt: timestamp('raised_at').defaultNow(),
    answeredAt: timestamp('answered_at'),
});
export const meetingWaitingRoom = pgTable('meeting_waiting_room', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    userId: integer('user_id').references(() => users.id),
    joinedAt: timestamp('joined_at').defaultNow(),
    status: text('status').default('waiting'), // 'waiting' | 'approved' | 'rejected'
});

// Breakout Rooms
export const breakoutRooms = pgTable('breakout_rooms', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    roomName: text('room_name').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});
export const breakoutRoomParticipants = pgTable('breakout_room_participants', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    breakoutRoomId: uuid('breakout_room_id').references(() => breakoutRooms.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id),
});

export const polls = pgTable('polls', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    hostId: integer('host_id').references(() => users.id),
    question: text('question').notNull(),
    options: text('options').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
    closedAt: timestamp('closed_at'),
});

export const pollResponses = pgTable('poll_responses', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    pollId: uuid('poll_id').references(() => polls.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id),
    selectedOptionIndex: integer('selected_option_index').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
});

export const meetingRecordings = pgTable('meeting_recordings', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    recordingPath: text('recording_path').notNull(),
    duration: integer('duration'), // seconds
    size: bigint('size', { mode: 'number' }), // bytes
    createdAt: timestamp('created_at').defaultNow(),
});

// Meeting Transcription
export const meetingTranscriptions = pgTable('meeting_transcriptions', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    content: text('content').notNull(),
    segments: text('segments'), // JSON string of transcription segments
    createdAt: timestamp('created_at').defaultNow(),
});

export const virtualBackgrounds = pgTable('virtual_backgrounds', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'image' | 'video'
    imageUrl: text('image_url'),
    color: text('color'),
    isDefault: boolean('is_default').default(false),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

export const whiteboardSessions = pgTable('whiteboard_sessions', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    meetingCode: text('meeting_code').references(() => meetings.meetingCode),
    drawingData: text('drawing_data'), // JSON string of drawing actions
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow()
});

