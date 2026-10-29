import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { CalendarCheck } from 'lucide-react';
import BookingsDashboard from '@/components/bookings/BookingsDashboard';
import { LoadError, Loading, MIGRATION_HINT, PageHeading } from '@/components/admin/PageStates';
import { requireWorkspacePage } from '@/lib/auth';
import { listDashboardBookings, listRentals, listServices } from '@/lib/bookings';
import { enabledModules } from '@/lib/modules-agent';
import { publicAppUrl } from '@/lib/public-url';
import { hasRole } from '@/lib/workspace-roles';
import { errorMessage } from '@/lib/retell';

async function Bookings({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const { workspace, role } = await requireWorkspacePage(slug, 'member', '/bookings');

  let data;
  try {
    const [modules, services, rentals, bookings] = await Promise.all([
      enabledModules(workspace.id),
      listServices(workspace.id),
      listRentals(workspace.id),
      listDashboardBookings(workspace.id),
    ]);
    data = { modules, services, rentals, bookings };
  } catch (error) {
    return <LoadError title="Couldn’t load bookings" message={errorMessage(error)} hint={MIGRATION_HINT} />;
  }

  if (!data.modules.length) {
    return (
      <div className="flex gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
          <CalendarCheck className="h-5 w-5" />
        </span>
        <div>
          <h2 className="font-semibold text-slate-900">No booking module is on</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600">
            Turn on Reservations or Short-term rentals and your agent can check what’s free and book it during the call.
          </p>
          {hasRole(role, 'admin') && (
            <Link
              href={`/w/${slug}/modules`}
              className="mt-3 inline-flex rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500"
            >
              Set up modules
            </Link>
          )}
        </div>
      </div>
    );
  }
  return (
    <BookingsDashboard
      modules={data.modules}
      services={data.services}
      rentals={data.rentals}
      initialBookings={data.bookings}
      connected={Boolean(publicAppUrl())}
    />
  );
}

export default function BookingsPage({ params }: PageProps<'/w/[slug]/bookings'>) {
  return (
    <>
      <PageHeading title="Bookings" description="Reservations as they come in, from your agent’s calls and your team." />
      <Suspense fallback={<Loading label="Loading bookings…" />}>
        <Bookings params={params} />
      </Suspense>
    </>
  );
}
