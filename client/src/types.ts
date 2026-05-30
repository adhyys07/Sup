export type AdminSection = 'overview' | 'meetings' | 'audit' | 'users';

export type AdminSummary = {
  totals: {
    users: number;
    meetings: number;
    activeMeetings: number;
    scheduledMeetings: number;
    auditLogs: number;
    recordings: number;
    messages: number;
  };
  recentAuditLogs: AuditLog[];
};

export type UserProfile = {
  id: number;
  email: string;
  name: string;
  avatar?: string | null;
  bio?: string | null;
  googleCalendarConnected?: boolean;
};

export type AdminUser = {
  id: number;
  email: string;
  name: string;
  authProvider?: string | null;
  emailVerified?: boolean | null;
  googleCalendarEmail?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  hostedMeetingCount: number;
  joinedMeetingCount: number;
};

export type AdminMeeting = {
  id: number;
  hostId: number;
  title?: string | null;
  meetingCode: string;
  scheduledTime?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  isRecording?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  hostName?: string | null;
  hostEmail?: string | null;
  durationSeconds?: number | null;
  participantCount: number;
  recordingCount: number;
  messageCount: number;
  latestAuditLog?: Pick<AuditLog, 'id' | 'action' | 'actorName' | 'durationSeconds' | 'occurredAt'> | null;
};

export type AuditDetails = string | Record<string, string | number | boolean | null> | null;

export type AuditLog = {
  id: string;
  meetingId?: number | null;
  meetingCode: string;
  userId?: number | null;
  actorName?: string | null;
  action: string;
  details?: AuditDetails;
  durationSeconds?: number | null;
  occurredAt?: string | null;
  createdAt?: string | null;
  meetingTitle?: string | null;
  userEmail?: string | null;
  userName?: string | null;
};

export type MeetingDetail = AdminMeeting & {
  participants: Array<{
    id: number;
    userId: number;
    joinedAt?: string | null;
    leftAt?: string | null;
  }>;
  recordings: Array<{
    id: number;
    recordingUrl?: string | null;
    duration?: number | null;
    createdAt?: string | null;
  }>;
  messages: Array<{
    id: number;
    userId: number;
    message: string;
    createdAt?: string | null;
  }>;
  auditLogs: AuditLog[];
};

export type Paginated<T, K extends string> = {
  limit: number;
  offset: number;
  total: number;
} & Record<K, T[]>;

export type UserMeeting = {
  id: number;
  hostId: number;
  title?: string | null;
  meetingCode: string;
  scheduledTime?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt?: string | null;
  hostName?: string | null;
};

export type MeetingHistory = UserMeeting & {
  durationSeconds?: number | null;
  participantDurationSeconds?: number | null;
  participantCount: number;
  recordingCount: number;
  recordingDurationSeconds?: number | null;
  messageCount: number;
  auditLogs: AuditLog[];
};
