'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await login(email, password);
      router.push('/');
    } catch (err: any) {
      setError(err?.response?.data?.message || err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm bg-surface rounded-2xl p-8 border border-border">
        <div className="text-center mb-8">
          <div className="text-3xl font-bold text-accent">TVWatchTime</div>
          <div className="text-sm text-white/50 mt-1">Admin Console</div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs text-white/50 uppercase tracking-wide">Email</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full mt-1 px-4 py-3 bg-surface-alt rounded-lg border border-border text-white focus:border-accent focus:outline-none transition"
              placeholder="admin@example.com"
            />
          </div>
          <div>
            <label className="text-xs text-white/50 uppercase tracking-wide">Password</label>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full mt-1 px-4 py-3 bg-surface-alt rounded-lg border border-border text-white focus:border-accent focus:outline-none transition"
            />
          </div>
          {error ? <div className="text-danger text-sm bg-danger/10 rounded-lg px-4 py-2 border border-danger/20">{error}</div> : null}
          <button
            type="submit" disabled={loading}
            className="w-full py-3 bg-accent text-bg font-bold rounded-lg hover:bg-accent-muted transition disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          <a href="https://tvwatchtime.org/reset-password" target="_blank" rel="noopener" className="block text-center text-xs text-white/40 hover:text-white/60 transition mt-2">
            Forgot password?
          </a>
        </form>
      </div>
    </div>
  );
}
