import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  getAdminAuditLogs,
  getAdminMeetingDetail,
  getAdminMeetings,
  getAdminSummary,
  getAdminUsers,
  getMeetingHistory,
  getMeetings,
  getProfile,
  createMeeting,
  ApiError
} from './api';
import { Icon } from './icons';
import type { AdminMeeting, AdminSection, AdminSummary, AdminUser, AuditDetails, AuditLog, MeetingDetail, MeetingHistory, UserMeeting, UserProfile } from './types';

const legacyBase = import.meta.env.DEV ? 'http://localhost:3000' : '';

function legacyUrl(path: string) {
  return `${legacyBase}${path}`;
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not set';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDuration(seconds?: number | null) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '0m';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatAction(action?: string | null) {
  return String(action || 'event')
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDetails(details?: AuditDetails) {
  if (!details) return 'None';
  if (typeof details === 'string') return details;
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ') || 'None';
}

function meetingStatus(meeting: Pick<AdminMeeting, 'startedAt' | 'endedAt' | 'scheduledTime'>) {
  if (meeting.endedAt) return 'ended';
  if (meeting.startedAt) return 'active';
  if (meeting.scheduledTime) return 'scheduled';
  return 'active';
}

function isAccessError(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function AdminApp() {
  const [token] = useState(() => localStorage.getItem('token') || '');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [section, setSection] = useState<AdminSection>('overview');
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [meetings, setMeetings] = useState<AdminMeeting[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingDetail | null>(null);
  const [meetingStatusFilter, setMeetingStatusFilter] = useState('');
  const [meetingCode, setMeetingCode] = useState('');
  const [meetingHostId, setMeetingHostId] = useState('');
  const [auditMeetingCode, setAuditMeetingCode] = useState('');
  const [auditUserId, setAuditUserId] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [statusText, setStatusText] = useState('Loading admin data');
  const [error, setError] = useState('');

  const metrics = useMemo(() => {
    const totals = summary?.totals;
    return [
      ['Users', totals?.users ?? 0, 'users'],
      ['Meetings', totals?.meetings ?? 0, 'video'],
      ['Active', totals?.activeMeetings ?? 0, 'activity'],
      ['Scheduled', totals?.scheduledMeetings ?? 0, 'layout'],
      ['Logs', totals?.auditLogs ?? 0, 'activity'],
      ['Recordings', totals?.recordings ?? 0, 'video']
    ] as const;
  }, [summary]);

  async function loadSummary() {
    const data = await getAdminSummary(token);
    setSummary(data);
  }

  async function loadUsers() {
    const data = await getAdminUsers(token);
    setUsers(data.users);
  }

  async function loadMeetings() {
    const params = new URLSearchParams({ limit: '50' });
    if (meetingStatusFilter) params.set('status', meetingStatusFilter);
    if (meetingCode.trim()) params.set('code', meetingCode.trim());
    if (meetingHostId.trim()) params.set('hostId', meetingHostId.trim());
    const data = await getAdminMeetings(token, params);
    setMeetings(data.meetings);
  }

  async function loadAuditLogs() {
    const params = new URLSearchParams({ limit: '80' });
    if (auditMeetingCode.trim()) params.set('meetingCode', auditMeetingCode.trim());
    if (auditUserId.trim()) params.set('userId', auditUserId.trim());
    if (auditAction.trim()) params.set('action', auditAction.trim());
    const data = await getAdminAuditLogs(token, params);
    setAuditLogs(data.auditLogs);
  }

  async function refresh(forceSummary = true) {
    if (!token) {
      window.location.href = legacyUrl('/');
      return;
    }

    setLoading(true);
    setError('');
    try {
      if (forceSummary || !summary) await loadSummary();
      if (section === 'meetings') await loadMeetings();
      if (section === 'audit') await loadAuditLogs();
      if (section === 'users') await loadUsers();
      setStatusText(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      if (isAccessError(err)) {
        setAccessDenied(true);
        return;
      }
      setError('Unable to load admin data.');
      setStatusText('Unable to load admin data');
    } finally {
      setLoading(false);
    }
  }

  async function openMeetingDetail(id: number) {
    setLoading(true);
    try {
      setSelectedMeeting(await getAdminMeetingDetail(token, id));
    } catch (err) {
      if (isAccessError(err)) {
        setAccessDenied(true);
        return;
      }
      setError('Unable to load meeting detail.');
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem('token');
    window.location.href = legacyUrl('/');
  }

  useEffect(() => {
    async function init() {
      if (!token) {
        window.location.href = legacyUrl('/');
        return;
      }

      try {
        await loadSummary();
        setProfile(await getProfile(token));
        setStatusText(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      } catch (err) {
        if (isAccessError(err)) setAccessDenied(true);
        else setError('Unable to load admin data.');
      } finally {
        setLoading(false);
      }
    }

    void init();
    // The first load is intentionally one-shot; section changes use the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!accessDenied && summary) void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  if (accessDenied) {
    return (
      <main className="access-denied">
        <section className="access-panel">
          <span className="brand-mark"><Icon name="user" /></span>
          <h1>Admin Access Required</h1>
          <p>This area is only available to workspace admins.</p>
          <a className="btn primary" href={legacyUrl('/dashboard.html')}><Icon name="arrowLeft" />Back to Dashboard</a>
        </section>
      </main>
    );
  }

  return (
    <div className={loading ? 'shell loading' : 'shell'}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="activity" /></span>
          <span>Sup Admin</span>
        </div>

        <nav className="nav" aria-label="Admin sections">
          <NavButton active={section === 'overview'} icon="layout" label="Overview" onClick={() => setSection('overview')} />
          <NavButton active={section === 'meetings'} icon="video" label="Meetings" onClick={() => setSection('meetings')} />
          <NavButton active={section === 'audit'} icon="activity" label="Audit Logs" onClick={() => setSection('audit')} />
          <NavButton active={section === 'users'} icon="users" label="Users" onClick={() => setSection('users')} />
          <a href={legacyUrl('/dashboard.html')}><Icon name="home" />Dashboard</a>
          <a href={legacyUrl('/profile.html')}><Icon name="user" />Profile</a>
        </nav>

        <div className="sidebar-footer">
          <div className="admin-user">
            <strong>{profile?.name || 'Admin'}</strong>
            <span>{profile?.email || 'Loading'}</span>
          </div>
          <button className="btn danger" type="button" onClick={logout}><Icon name="logout" />Logout</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="page-title">
            <h1>Meeting Operations</h1>
            <p>{statusText}</p>
          </div>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void refresh()}><Icon name="refresh" />Refresh</button>
            <a className="btn primary" href={legacyUrl('/dashboard.html')}><Icon name="arrowLeft" />Back to App</a>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <section className="summary-grid">
          {metrics.map(([label, value, iconName]) => (
            <article className="metric" key={label}>
              <div className="metric-top"><span>{label}</span><Icon name={iconName} /></div>
              <div className="metric-value">{value}</div>
            </article>
          ))}
        </section>

        {section === 'overview' && <Overview logs={summary?.recentAuditLogs || []} />}
        {section === 'meetings' && (
          <MeetingsPanel
            meetings={meetings}
            status={meetingStatusFilter}
            code={meetingCode}
            hostId={meetingHostId}
            setStatus={setMeetingStatusFilter}
            setCode={setMeetingCode}
            setHostId={setMeetingHostId}
            onApply={() => void loadMeetings()}
            onOpen={openMeetingDetail}
          />
        )}
        {section === 'audit' && (
          <AuditPanel
            logs={auditLogs}
            meetingCode={auditMeetingCode}
            userId={auditUserId}
            action={auditAction}
            setMeetingCode={setAuditMeetingCode}
            setUserId={setAuditUserId}
            setAction={setAuditAction}
            onApply={() => void loadAuditLogs()}
          />
        )}
        {section === 'users' && <UsersPanel users={users} />}
      </main>

      {selectedMeeting && (
        <MeetingModal meeting={selectedMeeting} onClose={() => setSelectedMeeting(null)} />
      )}
    </div>
  );
}

function NavButton(props: { active: boolean; icon: 'layout' | 'video' | 'activity' | 'users'; label: string; onClick: () => void }) {
  return (
    <button className={props.active ? 'active' : ''} type="button" onClick={props.onClick}>
      <Icon name={props.icon} />
      {props.label}
    </button>
  );
}

function Overview({ logs }: { logs: AuditLog[] }) {
  return (
    <Panel title="Recent Activity" description="Latest meeting audit events across the workspace.">
      <DataTable
        empty="No recent audit activity."
        headers={['Time', 'Meeting', 'Actor', 'Action', 'Duration']}
        rows={logs.map((log) => [
          <span className="mono">{formatDate(log.occurredAt)}</span>,
          <MeetingCell title={log.meetingTitle} code={log.meetingCode} />,
          log.actorName || 'System',
          <span className="pill">{formatAction(log.action)}</span>,
          formatDuration(log.durationSeconds)
        ])}
      />
    </Panel>
  );
}

function MeetingsPanel(props: {
  meetings: AdminMeeting[];
  status: string;
  code: string;
  hostId: string;
  setStatus: (value: string) => void;
  setCode: (value: string) => void;
  setHostId: (value: string) => void;
  onApply: () => void;
  onOpen: (id: number) => void;
}) {
  return (
    <Panel
      title="All Meetings"
      description="Filter by status, host id, or meeting code."
      actions={(
        <div className="filters">
          <select className="field" value={props.status} onChange={(event) => props.setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="scheduled">Scheduled</option>
            <option value="ended">Ended</option>
          </select>
          <input className="field" value={props.code} onChange={(event) => props.setCode(event.target.value)} placeholder="Meeting code" />
          <input className="field" value={props.hostId} onChange={(event) => props.setHostId(event.target.value)} placeholder="Host id" inputMode="numeric" />
          <button className="btn primary" type="button" onClick={props.onApply}><Icon name="filter" />Apply</button>
        </div>
      )}
    >
      <DataTable
        empty="No meetings found."
        headers={['Meeting', 'Host', 'Status', 'Duration', 'Activity', '']}
        rows={props.meetings.map((meeting) => {
          const status = meetingStatus(meeting);
          return [
            <MeetingCell title={meeting.title} code={meeting.meetingCode} />,
            <><span>{meeting.hostName || 'Unknown'}</span><br /><span className="muted">{meeting.hostEmail || 'No email'}</span></>,
            <><span className={`pill ${status}`}>{status}</span><br /><span className="muted">{formatDate(meeting.scheduledTime || meeting.startedAt || meeting.createdAt)}</span></>,
            formatDuration(meeting.durationSeconds),
            <span className="chip-row">
              <span className="pill">{meeting.participantCount || 0} participants</span>
              <span className="pill">{meeting.messageCount || 0} messages</span>
              <span className="pill">{meeting.recordingCount || 0} recordings</span>
            </span>,
            <button className="btn" type="button" onClick={() => props.onOpen(meeting.id)}><Icon name="layout" />Details</button>
          ];
        })}
      />
    </Panel>
  );
}

function AuditPanel(props: {
  logs: AuditLog[];
  meetingCode: string;
  userId: string;
  action: string;
  setMeetingCode: (value: string) => void;
  setUserId: (value: string) => void;
  setAction: (value: string) => void;
  onApply: () => void;
}) {
  return (
    <Panel
      title="Audit Logs"
      description="Search global meeting events."
      actions={(
        <div className="filters">
          <input className="field" value={props.meetingCode} onChange={(event) => props.setMeetingCode(event.target.value)} placeholder="Meeting code" />
          <input className="field" value={props.userId} onChange={(event) => props.setUserId(event.target.value)} placeholder="User id" inputMode="numeric" />
          <input className="field" value={props.action} onChange={(event) => props.setAction(event.target.value)} placeholder="Action" />
          <button className="btn primary" type="button" onClick={props.onApply}><Icon name="filter" />Apply</button>
        </div>
      )}
    >
      <DataTable
        empty="No audit logs found."
        headers={['Time', 'Meeting', 'User', 'Action', 'Details']}
        rows={props.logs.map((log) => [
          <span className="mono">{formatDate(log.occurredAt)}</span>,
          <MeetingCell title={log.meetingTitle} code={log.meetingCode} />,
          <><span>{log.userName || log.actorName || 'System'}</span><br /><span className="muted">{log.userEmail || (log.userId ? `ID ${log.userId}` : '')}</span></>,
          <><span className="pill">{formatAction(log.action)}</span><br /><span className="muted">{formatDuration(log.durationSeconds)}</span></>,
          formatDetails(log.details)
        ])}
      />
    </Panel>
  );
}

function UsersPanel({ users }: { users: AdminUser[] }) {
  return (
    <Panel title="Users" description="Accounts with hosted and joined meeting counts.">
      <DataTable
        empty="No users found."
        headers={['User', 'Auth', 'Email', 'Calendar', 'Meetings']}
        rows={users.map((user) => [
          <><span className="strong">{user.name || 'User'}</span><br /><span className="mono muted">ID {user.id}</span></>,
          <span className="pill">{user.authProvider || 'local'}</span>,
          <><span>{user.email}</span><br /><span className="muted">{user.emailVerified ? 'Verified' : 'Unverified'}</span></>,
          user.googleCalendarEmail || 'Not connected',
          <span className="chip-row">
            <span className="pill">{user.hostedMeetingCount || 0} hosted</span>
            <span className="pill">{user.joinedMeetingCount || 0} joined</span>
          </span>
        ])}
      />
    </Panel>
  );
}

function MeetingModal({ meeting, onClose }: { meeting: MeetingDetail; onClose: () => void }) {
  const logs = meeting.auditLogs || [];
  return (
    <div className="modal active" role="dialog" aria-modal="true">
      <div className="modal-panel">
        <div className="modal-head">
          <div>
            <h2>{meeting.title || 'Meeting'}</h2>
            <p className="muted">{meeting.meetingCode}</p>
          </div>
          <button className="btn" type="button" onClick={onClose}><Icon name="close" />Close</button>
        </div>
        <div className="modal-body">
          <div className="detail-grid">
            <DetailCell label="Host" value={`${meeting.hostName || 'Unknown'} / ${meeting.hostEmail || 'No email'}`} />
            <DetailCell label="Status" value={meetingStatus(meeting)} />
            <DetailCell label="Duration" value={formatDuration(meeting.durationSeconds)} />
            <DetailCell label="Started" value={formatDate(meeting.startedAt)} />
            <DetailCell label="Participants" value={String(meeting.participants?.length || 0)} />
            <DetailCell label="Messages" value={String(meeting.messages?.length || 0)} />
            <DetailCell label="Recordings" value={String(meeting.recordings?.length || 0)} />
            <DetailCell label="Created" value={formatDate(meeting.createdAt)} />
          </div>

          <section className="detail-panel">
            <div className="panel-head compact">
              <div>
                <h2>Audit Trail</h2>
                <p>{logs.length} events</p>
              </div>
            </div>
            <div className="stack">
              {logs.length ? logs.map((log) => (
                <div className="log-line" key={log.id}>
                  <span className="mono muted">{formatDate(log.occurredAt)}</span>
                  <span>
                    <span className="strong">{formatAction(log.action)}</span> by {log.actorName || 'System'}
                    <br />
                    <span className="muted">{formatDetails(log.details)}</span>
                  </span>
                </div>
              )) : <div className="empty">No audit events recorded.</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MeetingCell({ title, code }: { title?: string | null; code?: string | null }) {
  return (
    <>
      <span className="strong">{title || 'Meeting'}</span>
      <br />
      <span className="mono muted">{code || ''}</span>
    </>
  );
}

function Panel({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          )) : (
            <tr><td className="empty" colSpan={headers.length}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DashboardApp() {
  const [token] = useState(() => localStorage.getItem('token') || '');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [meetings, setMeetings] = useState<UserMeeting[]>([]);
  const [history, setHistory] = useState<MeetingHistory[]>([]);
  const [title, setTitle] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadDashboard() {
    if (!token) {
      window.location.href = legacyUrl('/');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const [profileData, meetingRows, historyRows] = await Promise.all([
        getProfile(token),
        getMeetings(token),
        getMeetingHistory(token)
      ]);
      setProfile(profileData);
      setMeetings(meetingRows);
      setHistory(historyRows);
    } catch (err) {
      if (isAccessError(err)) {
        window.location.href = legacyUrl('/');
        return;
      }
      setError('Unable to load dashboard.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateMeeting(event: FormEvent) {
    event.preventDefault();
    try {
      const meeting = await createMeeting(token, {
        title: title.trim() || 'Meeting',
        scheduledTime: scheduledTime || undefined
      });
      setTitle('');
      setScheduledTime('');
      await loadDashboard();
      if (!meeting.scheduledTime) {
        window.location.href = legacyUrl(`/meeting.html?room=${encodeURIComponent(meeting.meetingCode)}`);
      }
    } catch {
      setError('Unable to create meeting.');
    }
  }

  function joinMeeting(code: string) {
    const cleaned = extractMeetingCode(code);
    if (!cleaned) return;
    window.location.href = legacyUrl(`/meeting.html?room=${encodeURIComponent(cleaned)}`);
  }

  function instantMeeting() {
    const code = Math.random().toString(36).substring(2, 11).toUpperCase();
    joinMeeting(code);
  }

  useEffect(() => {
    void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const totalMeetings = Math.max(meetings.length, history.length);
  const scheduledCount = meetings.filter((meeting) => meeting.scheduledTime).length;
  const instantCount = Math.max(0, totalMeetings - scheduledCount);

  return (
    <div className={loading ? 'app-page loading' : 'app-page'}>
      <header className="app-nav">
        <div className="brand">
          <span className="brand-mark"><Icon name="video" /></span>
          <span>Sup</span>
        </div>
        <nav className="top-links">
          <a href={legacyUrl('/dashboard.html')}>Legacy</a>
          <a href={legacyUrl('/profile.html')}>Profile</a>
          <a href="/app/admin">Admin</a>
        </nav>
        <button className="btn danger" type="button" onClick={() => {
          localStorage.removeItem('token');
          window.location.href = legacyUrl('/');
        }}><Icon name="logout" />Logout</button>
      </header>

      <main className="dashboard-main">
        <section className="dashboard-hero">
          <div>
            <p className="eyebrow">Welcome back</p>
            <h1>{profile?.name ? `${profile.name}'s workspace` : 'Meeting workspace'}</h1>
            <p>Start a room, schedule a session, or review what happened across your recent meetings.</p>
            <div className="hero-actions">
              <button className="btn primary" type="button" onClick={instantMeeting}><Icon name="video" />Instant Meeting</button>
              <form className="join-form" onSubmit={(event) => {
                event.preventDefault();
                joinMeeting(joinCode);
              }}>
                <input className="field" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Code or invite link" />
                <button className="btn" type="submit"><Icon name="arrowLeft" />Join</button>
              </form>
            </div>
          </div>
          <div className="dashboard-stats">
            <article><strong>{totalMeetings}</strong><span>Total meetings</span></article>
            <article><strong>{scheduledCount}</strong><span>Scheduled</span></article>
            <article><strong>{instantCount}</strong><span>Instant</span></article>
          </div>
        </section>

        {error && <div className="error-banner">{error}</div>}

        <section className="dashboard-grid">
          <Panel title="Create Meeting" description="Schedule one for later or leave time empty to create an instant meeting.">
            <form className="create-form" onSubmit={handleCreateMeeting}>
              <input className="field" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Meeting title" />
              <input className="field" type="datetime-local" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} />
              <button className="btn primary" type="submit"><Icon name="video" />Create</button>
            </form>
          </Panel>

          <Panel title="Upcoming Meetings" description="Scheduled meetings you host or participate in.">
            <div className="card-list">
              {meetings.length ? meetings.map((meeting) => (
                <MeetingCard key={meeting.id} meeting={meeting} onJoin={joinMeeting} />
              )) : <div className="empty">No upcoming meetings.</div>}
            </div>
          </Panel>
        </section>

        <Panel title="Past Meeting Activity" description="Durations, participants, recordings, messages, and latest audit events.">
          <div className="history-list">
            {history.length ? history.map((meeting) => (
              <HistoryCard key={meeting.id} meeting={meeting} onJoin={joinMeeting} />
            )) : <div className="empty">No past meeting activity yet.</div>}
          </div>
        </Panel>
      </main>
    </div>
  );
}

function MeetingCard({ meeting, onJoin }: { meeting: UserMeeting; onJoin: (code: string) => void }) {
  return (
    <article className="meeting-card-react">
      <div>
        <h3>{meeting.title || 'Meeting'}</h3>
        <p className="mono">{getMeetingShareLink(meeting.meetingCode)}</p>
        <p className="muted">Host: {meeting.hostName || 'Unknown'}</p>
        <p className="muted">{meeting.scheduledTime ? `Scheduled: ${formatDate(meeting.scheduledTime)}` : 'Instant meeting'}</p>
      </div>
      <div className="card-actions">
        <button className="btn primary" type="button" onClick={() => onJoin(meeting.meetingCode)}>Join</button>
        <button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(getMeetingShareLink(meeting.meetingCode))}>Copy</button>
        <button className="btn" type="button" onClick={() => openGoogleCalendar(meeting)}>Calendar</button>
        <button className="btn" type="button" onClick={() => downloadICS(meeting)}>ICS</button>
      </div>
    </article>
  );
}

function HistoryCard({ meeting, onJoin }: { meeting: MeetingHistory; onJoin: (code: string) => void }) {
  const logs = meeting.auditLogs?.slice(0, 4) || [];
  return (
    <article className="history-card-react">
      <div className="history-topline">
        <div>
          <h3>{meeting.title || 'Meeting'}</h3>
          <p className="muted">Host: {meeting.hostName || 'Unknown'} / <span className="mono">{meeting.meetingCode}</span></p>
        </div>
        <button className="btn" type="button" onClick={() => onJoin(meeting.meetingCode)}>Reopen</button>
      </div>
      <p className="muted">Started: {formatDate(meeting.startedAt)} / Ended: {formatDate(meeting.endedAt)}</p>
      <div className="chip-row">
        <span className="pill active">Meeting: {formatDuration(meeting.durationSeconds)}</span>
        <span className="pill">Participant time: {formatDuration(meeting.participantDurationSeconds)}</span>
        <span className="pill">{meeting.participantCount || 0} participants</span>
        <span className="pill">{meeting.recordingCount || 0} recordings</span>
        <span className="pill">{meeting.messageCount || 0} messages</span>
      </div>
      <div className="mini-audit">
        {logs.length ? logs.map((log) => (
          <div key={log.id}>
            <span className="mono muted">{formatDate(log.occurredAt)}</span>
            <span><strong>{formatAction(log.action)}</strong> by {log.actorName || 'System'}</span>
          </div>
        )) : <span className="muted">No audit events recorded yet.</span>}
      </div>
    </article>
  );
}

function extractMeetingCode(raw: string) {
  const value = raw.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const room = url.searchParams.get('room');
    if (room) return room.trim().toUpperCase();
    const joinMatch = url.pathname.match(/\/join\/([^/]+)/i);
    if (joinMatch?.[1]) return decodeURIComponent(joinMatch[1]).trim().toUpperCase();
  } catch {
    const roomMatch = value.match(/[?&]room=([^&]+)/i);
    if (roomMatch?.[1]) return decodeURIComponent(roomMatch[1]).trim().toUpperCase();
    const joinMatch = value.match(/\/join\/([^/?#]+)/i);
    if (joinMatch?.[1]) return decodeURIComponent(joinMatch[1]).trim().toUpperCase();
  }
  return value.toUpperCase();
}

function getMeetingShareLink(code: string) {
  const origin = legacyBase || window.location.origin;
  return `${origin}/join/${encodeURIComponent(code)}`;
}

function toGoogleDateUTC(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.000', '');
}

function openGoogleCalendar(meeting: UserMeeting) {
  const start = meeting.scheduledTime ? new Date(meeting.scheduledTime) : new Date();
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const url =
    'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(meeting.title || 'Sup Meeting')}`
    + `&dates=${encodeURIComponent(`${toGoogleDateUTC(start)}/${toGoogleDateUTC(end)}`)}`
    + `&details=${encodeURIComponent(`Join meeting: ${getMeetingShareLink(meeting.meetingCode)}`)}`;
  window.open(url, '_blank');
}

function toICSDateUTC(date: Date) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function escapeICS(text: string) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function downloadICS(meeting: UserMeeting) {
  const start = meeting.scheduledTime ? new Date(meeting.scheduledTime) : new Date();
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const now = new Date();
  const title = meeting.title || 'Sup Meeting';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sup//Meetings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:sup-${meeting.meetingCode}-${now.getTime()}@sup.local`,
    `DTSTAMP:${toICSDateUTC(now)}`,
    `DTSTART:${toICSDateUTC(start)}`,
    `DTEND:${toICSDateUTC(end)}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(`Join meeting: ${getMeetingShareLink(meeting.meetingCode)}`)}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/\s+/g, '-').toLowerCase()}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

export default function App() {
  const path = window.location.pathname.toLowerCase();
  return path.includes('/dashboard') ? <DashboardApp /> : <AdminApp />;
}
