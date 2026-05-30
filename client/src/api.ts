import type { AdminMeeting, AdminSummary, AdminUser, AuditLog, MeetingDetail, MeetingHistory, Paginated, UserMeeting, UserProfile } from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, token: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders(token) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : 'Request failed';
    throw new ApiError(message, response.status);
  }

  return data as T;
}

export function getProfile(token: string) {
  return request<UserProfile>('/api/user/profile', token);
}

export function getAdminSummary(token: string) {
  return request<AdminSummary>('/api/admin/summary', token);
}

export function getAdminUsers(token: string) {
  return request<Paginated<AdminUser, 'users'>>('/api/admin/users?limit=50', token);
}

export function getAdminMeetings(token: string, params: URLSearchParams) {
  return request<Paginated<AdminMeeting, 'meetings'>>(`/api/admin/meetings?${params.toString()}`, token);
}

export function getAdminAuditLogs(token: string, params: URLSearchParams) {
  return request<Paginated<AuditLog, 'auditLogs'>>(`/api/admin/audit-logs?${params.toString()}`, token);
}

export function getAdminMeetingDetail(token: string, id: number) {
  return request<MeetingDetail>(`/api/admin/meetings/${encodeURIComponent(id)}`, token);
}

export function getMeetings(token: string) {
  return request<UserMeeting[]>('/api/meetings', token);
}

export function getMeetingHistory(token: string) {
  return request<MeetingHistory[]>('/api/meetings/history', token);
}

export function createMeeting(token: string, payload: { title: string; scheduledTime?: string }) {
  return fetch('/api/meetings', {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : 'Request failed';
      throw new ApiError(message, response.status);
    }
    return data as UserMeeting;
  });
}
