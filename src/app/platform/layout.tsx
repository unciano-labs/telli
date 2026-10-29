import SiteHeader from '@/components/SiteHeader';
import PlatformNav from '@/components/platform/PlatformNav';

export default function PlatformLayout({ children }: LayoutProps<'/platform'>) {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 sm:px-6">
        <PlatformNav />
        <div className="pt-8">{children}</div>
      </main>
    </div>
  );
}
