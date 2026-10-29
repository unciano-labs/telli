'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Copy, Loader2, UserPlus, XCircle } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import {
  assignableRoles,
  canManageMember,
  hasRole,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type WorkspaceRole,
} from '@/lib/workspace-roles';

export type MemberView = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: WorkspaceRole;
  joined_at: string;
};

export type InviteView = {
  id: string;
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  created_at: string;
  expires_at: string;
};

type Toast = { kind: 'success' | 'error'; text: string } | null;

const inputCls =
  'block w-full rounded-lg border-0 px-3 py-2 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600';

function Feedback({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
    <p
      role="status"
      className={`flex items-center gap-1.5 text-sm ${toast.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
    >
      {toast.kind === 'success' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
      {toast.text}
    </p>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Please try again.');
  return data;
}

export default function TeamManager({
  initialMembers,
  initialInvites,
  currentUserId,
}: {
  initialMembers: MemberView[];
  initialInvites: InviteView[];
  currentUserId: string;
}) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const { role, name } = useWorkspace();
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const canInvite = hasRole(role, 'admin');
  const roleChoices = assignableRoles(role);

  async function changeRole(member: MemberView, next: WorkspaceRole) {
    setBusy(member.user_id);
    setToast(null);
    try {
      const data = await send(`${api}/members`, 'PATCH', { userId: member.user_id, role: next });
      setMembers(data.members);
      setToast({ kind: 'success', text: `${member.full_name || member.email} is now ${ROLE_LABELS[next].toLowerCase()}.` });
      // Demoting yourself changes what you can see
      if (member.user_id === currentUserId) router.refresh();
    } catch (error) {
      setToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(member: MemberView) {
    const self = member.user_id === currentUserId;
    const prompt = self
      ? `Leave ${name}? You’ll lose access until someone invites you again.`
      : `Remove ${member.full_name || member.email} from ${name}?`;
    if (!window.confirm(prompt)) return;
    setBusy(member.user_id);
    setToast(null);
    try {
      await send(`${api}/members?userId=${member.user_id}`, 'DELETE');
      if (self) {
        router.push('/dashboard');
        return;
      }
      setMembers((list) => list.filter((m) => m.user_id !== member.user_id));
    } catch (error) {
      setToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(invite: InviteView) {
    setBusy(invite.id);
    setToast(null);
    try {
      await send(`${api}/invites?id=${invite.id}`, 'DELETE');
      setInvites((list) => list.filter((i) => i.id !== invite.id));
    } catch (error) {
      setToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section aria-labelledby="members-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-baseline justify-between">
          <h2 id="members-heading" className="font-semibold text-slate-900">
            Members
          </h2>
          <span className="text-sm text-slate-500">{members.length}</span>
        </div>
        <ul className="mt-4 divide-y divide-slate-100">
          {members.map((m) => {
            const self = m.user_id === currentUserId;
            const manageable = !self && canManageMember(role, m.role);
            return (
              <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {m.full_name || m.email || 'Unknown user'}
                    {self && <span className="ml-1.5 text-xs font-normal text-slate-500">(you)</span>}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {m.email} · joined {formatDate(m.joined_at)}
                  </p>
                </div>
                {manageable && roleChoices.length ? (
                  <select
                    aria-label={`Role for ${m.full_name || m.email}`}
                    value={m.role}
                    disabled={busy === m.user_id}
                    onChange={(e) => changeRole(m, e.target.value as WorkspaceRole)}
                    className="rounded-lg border-0 py-1.5 pl-3 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-600"
                  >
                    {roleChoices.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                    {ROLE_LABELS[m.role]}
                  </span>
                )}
                {(self || manageable) && (
                  <button
                    onClick={() => remove(m)}
                    disabled={busy === m.user_id}
                    className="text-sm font-medium text-red-600 hover:text-red-500 disabled:opacity-50"
                  >
                    {self ? 'Leave' : 'Remove'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-4">
          <Feedback toast={toast} />
        </div>
        <dl className="mt-6 grid gap-2 rounded-xl bg-slate-50 p-4 text-xs text-slate-600 sm:grid-cols-3">
          {(['owner', 'admin', 'member'] as const).map((r) => (
            <div key={r}>
              <dt className="font-semibold text-slate-800">{ROLE_LABELS[r]}</dt>
              <dd>{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </section>

      {canInvite && (
        <div className="space-y-8">
          <InviteForm onInvited={(invite) => setInvites((list) => [invite, ...list.filter((i) => i.email !== invite.email)])} />
          <section aria-labelledby="invites-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 id="invites-heading" className="font-semibold text-slate-900">
              Pending invites
            </h2>
            {invites.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No pending invites.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {invites.map((invite) => {
                  const expired = new Date(invite.expires_at) < new Date();
                  return (
                    <li key={invite.id} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{invite.email}</p>
                        <p className="text-xs text-slate-500">
                          {ROLE_LABELS[invite.role]} ·{' '}
                          {expired ? (
                            <span className="text-amber-700">expired</span>
                          ) : (
                            `expires ${formatDate(invite.expires_at)}`
                          )}
                        </p>
                      </div>
                      <button
                        onClick={() => revoke(invite)}
                        disabled={busy === invite.id}
                        className="text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function InviteForm({ onInvited }: { onInvited: (invite: InviteView) => void }) {
  const api = useWorkspaceApi();
  const { role } = useWorkspace();
  const choices = assignableRoles(role).filter((r): r is InviteView['role'] => r !== 'owner');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteView['role']>('member');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => ''
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setToast(null);
    setLink(null);
    setCopied(false);
    try {
      const data = await send(`${api}/invites`, 'POST', { email, role: inviteRole });
      onInvited(data.invite);
      setLink({ email: data.invite.email, url: origin + data.path });
      setEmail('');
    } catch (error) {
      setToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
  }

  return (
    <section aria-labelledby="invite-heading" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h2 id="invite-heading" className="font-semibold text-slate-900">
        Invite someone
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        You’ll get a link to send them. It works once, for 7 days, and only for that email address.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`mt-1 ${inputCls}`}
            placeholder="teammate@business.com"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Role
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as InviteView['role'])}
            className={`mt-1 ${inputCls}`}
          >
            {choices.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}: {ROLE_DESCRIPTIONS[r]}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={sending}
          className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Create invite link
        </button>
        <Feedback toast={toast} />
      </form>

      {link && (
        <div className="mt-4 rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
          <p className="text-sm font-medium text-emerald-900">Send this link to {link.email}</p>
          <p className="mt-1 text-xs text-emerald-800">It won’t be shown again. If it’s lost, create a new invite.</p>
          <div className="mt-3 flex gap-2">
            <input readOnly value={link.url} aria-label="Invite link" className={`${inputCls} bg-white font-mono text-xs`} />
            <button
              type="button"
              onClick={copy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              <Copy className="h-4 w-4" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
