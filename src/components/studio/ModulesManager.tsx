'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CalendarCheck, Home, Loader2 } from 'lucide-react';
import { useWorkspace, useWorkspaceApi } from '@/components/workspace/WorkspaceContext';
import { Card } from '@/components/bookings/BookingParts';
import { ErrorText, ReservationSettingsForm, send, ServicesList } from '@/components/studio/ServicesEditor';
import { RentalSettingsForm, RentalsList } from '@/components/studio/RentalsEditor';
import { hasRole } from '@/lib/workspace-roles';
import { defaultSettings, MODULES, type ModuleId, type ModuleState, type RentalSettings, type ReservationSettings } from '@/lib/modules-shared';
import type { Rental, Service } from '@/lib/bookings';

const ICONS: Record<ModuleId, typeof Home> = { reservations: CalendarCheck, rentals: Home };

export default function ModulesManager({
  initialModules,
  services,
  rentals,
  connected,
}: {
  initialModules: ModuleState[];
  services: Service[];
  rentals: Rental[];
  /** Agent functions need a public address to call. */
  connected: boolean;
}) {
  const api = useWorkspaceApi();
  const router = useRouter();
  const { role, slug } = useWorkspace();
  const canEdit = hasRole(role, 'admin');
  const [modules, setModules] = useState(initialModules);
  const [busy, setBusy] = useState<ModuleId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = <M extends ModuleId>(m: M) =>
    (modules.find((x) => x.module === m) as ModuleState<M> | undefined) ?? { module: m, enabled: false, settings: defaultSettings(m) };
  const enabled = modules.filter((m) => m.enabled).map((m) => m.module);
  const reservations = state('reservations');
  const rentalsModule = state('rentals');

  async function patch(module: ModuleId, body: { enabled?: boolean; settings?: object }) {
    const { module: saved } = await send(`${api}/modules`, 'PATCH', { module, ...body });
    setModules((list) => [...list.filter((m) => m.module !== module), saved]);
  }

  async function toggle(module: ModuleId, on: boolean) {
    setBusy(module);
    setError(null);
    try {
      await patch(module, { enabled: on });
      // The workspace menu shows Bookings only while a module is on
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {!connected && enabled.length > 0 && (
        <p className="flex gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          The agent can’t reach the booking calendar from this address. Set PUBLIC_APP_URL to the app’s public https address (the
          deployed site, or a tunnel while testing locally). Until then the agent takes details and says the team will confirm.
        </p>
      )}
      <ErrorText error={error} />

      <div className="grid gap-4 md:grid-cols-2">
        {(Object.keys(MODULES) as ModuleId[]).map((m) => {
          const on = state(m).enabled;
          const Icon = ICONS[m];
          return (
            <div key={m} className={`flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ${on ? 'ring-indigo-300' : 'ring-slate-200'}`}>
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${on ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>
                <Icon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-slate-900">{MODULES[m].label}</p>
                <p className="mt-0.5 text-sm text-slate-500">{MODULES[m].description}</p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${MODULES[m].label} module`}
                  disabled={busy !== null}
                  onClick={() => toggle(m, !on)}
                  className={`relative mt-1 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-60 ${on ? 'bg-indigo-600' : 'bg-slate-300'}`}
                >
                  {busy === m ? (
                    <Loader2 className="absolute inset-0 m-auto h-3.5 w-3.5 animate-spin text-white" />
                  ) : (
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${on ? 'left-[18px]' : 'left-0.5'}`} />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canEdit && <p className="-mt-3 text-xs text-slate-500">Turning a module on or off changes the draft: test it, then publish. Services, hours and apartments apply to calls right away.</p>}

      {enabled.length > 0 && (
        <p className="text-sm text-slate-600">
          Reservations made by the agent show up live on the{' '}
          <Link href={`/w/${slug}/bookings`} className="font-medium text-indigo-600 hover:underline">
            Bookings
          </Link>{' '}
          tab.
        </p>
      )}

      {reservations.enabled && (
        <>
          <Card title="Services">
            <ServicesList initial={services} currency={reservations.settings.currency} canEdit={canEdit} />
          </Card>
          <Card title="Opening hours and booking rules">
            <ReservationSettingsForm
              settings={reservations.settings as ReservationSettings}
              canEdit={canEdit}
              onSave={(settings) => patch('reservations', { settings })}
            />
          </Card>
        </>
      )}

      {rentalsModule.enabled && (
        <>
          <Card title="Apartments">
            <RentalsList initial={rentals} currency={rentalsModule.settings.currency} canEdit={canEdit} />
          </Card>
          <Card title="Check-in and check-out">
            <RentalSettingsForm settings={rentalsModule.settings as RentalSettings} canEdit={canEdit} onSave={(settings) => patch('rentals', { settings })} />
          </Card>
        </>
      )}
    </div>
  );
}
