import { pgTable, serial, varchar, text, boolean, timestamp, integer, foreignKey, unique, index } from 'drizzle-orm/pg-core';

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
