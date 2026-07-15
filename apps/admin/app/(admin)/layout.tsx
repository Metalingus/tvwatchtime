'use client';

import { useAuth } from '@/lib/auth';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useEffect } from 'react';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '📊', roles: ['VIEWER','SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/analytics', label: 'Analytics', icon: '📈', roles: ['VIEWER','SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/media', label: 'Media', icon: '🎬', roles: ['VIEWER','SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/users', label: 'Users', icon: '👥', roles: ['SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/contacts', label: 'Contact', icon: '🎧', roles: ['SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/moderation', label: 'Moderation', icon: '🚨', roles: ['MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/jobs', label: 'Hydration Jobs', icon: '⚡', roles: ['VIEWER','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/providers', label: 'Metadata Providers', icon: '🌐', roles: ['ADMIN','SUPER_ADMIN'] },
  { href: '/scheduled-hydrations', label: 'Auto Hydrations', icon: '🔄', roles: ['VIEWER','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/cron', label: 'Scheduled Jobs', icon: '⏰', roles: ['VIEWER','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'] },
  { href: '/admins', label: 'Admins', icon: '🛡️', roles: ['ADMIN','SUPER_ADMIN'] },
  { href: '/announcements', label: 'Announcements', icon: '📢', roles: ['ADMIN','SUPER_ADMIN'] },
  { href: '/broadcast', label: 'Broadcast', icon: '📡', roles: ['ADMIN','SUPER_ADMIN'] },
  { href: '/logs', label: 'Audit Logs', icon: '📋', roles: ['ADMIN','SUPER_ADMIN'] },
  { href: '/settings', label: 'Settings', icon: '⚙️', roles: ['ADMIN','SUPER_ADMIN'] },
];

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN: 'text-danger', ADMIN: 'text-accent', CONTENT_MANAGER: 'text-success',
  SUPPORT: 'text-blue-400', VIEWER: 'text-white/40', USER: 'text-white/20',
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-bg"><div className="text-accent text-xl">Loading...</div></div>;

  const navItems = NAV.filter((n) => n.roles.includes(user.role));

  return (
    <div className="min-h-screen bg-bg flex">
      {/* Sidebar */}
      <aside className="w-60 bg-surface border-r border-border flex flex-col shrink-0">
        <div className="p-5 border-b border-border">
          <div className="text-lg font-bold text-accent">TVWatchTime</div>
          <div className="text-xs text-white/40">Admin Console</div>
        </div>
        <nav className="flex-1 py-4">
          {navItems.map((item) => {
            const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}
                className={`flex items-center gap-3 px-5 py-2.5 text-sm transition ${active ? 'bg-surface-alt text-accent border-l-2 border-accent' : 'text-white/60 hover:text-white hover:bg-surface-alt/50'}`}>
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-surface-alt flex items-center justify-center text-sm font-bold text-accent">
              {user.username[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{user.username}</div>
              <div className={`text-xs ${ROLE_COLORS[user.role] || 'text-white/40'}`}>{user.role}</div>
            </div>
          </div>
          <button onClick={logout} className="w-full text-xs text-white/40 hover:text-danger transition py-2">Sign Out</button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8 max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
