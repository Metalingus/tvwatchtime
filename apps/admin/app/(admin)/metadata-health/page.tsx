'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';

interface MetadataHealth {
  total: number;
  neverHydrated: number;
  showsMissingEpisodes: number;
  moviesMissingOverview: number;
  tvdbOnly: number;
  tvdbFallbackShows: number;
  stale: number;
  byClassification: Record<string, number>;
  animeOnTmdb: number;
  animeOnTmdbNoTvdbId: number;
  structuralTypeMismatch: number;
  castMissingCharacterIds: number;
  pendingCharacterVoteItems: number;
  pendingCharacterVoteShows: number;
  pendingCharacterVoteMovies: number;
  pendingCharacterVoteShowsWithoutTvdb: number;
  movieDataOnShows: number;
  multiTvdbIds: number;
  multiTvdbIdsActionable: number;
  multiTvdbIdsAmbiguous: number;
  wrongKindExternalIdAliases: number;
  wrongKindExternalIdMedia: number;
  authorityMissing: number;
  authorityInvalid: number;
  authorityOutdated: number;
  legacyUnmappedEpisodes: number;
  legacyUnmappedShows: number;
  legacyUnmappedWithUserData: number;
  providerDuplicateMovies: number;
  nonEnglishBase: number;
  nonEnglishContent: number | null;
  nonEnglishContentParked: number | null;
  nonEnglishContentDeep: {
    totalEligible: number;
    unverified: number;
    remainingInPass: number;
    cursorPosition: number;
    cursorActive: boolean;
    verifierVersion: number;
  };
  bannerAsPoster: number;
  missingRating: number;
  animeTvdbUnresolvable: number;
  recommendationsMissing: number;
  moviesMissingCountry: number;
  castDuplicateMedia: number;
  castDuplicateRows: number;
  castDuplicateVotes: number;
  dualStructureShows: number;
}

/** Live progress of one background repair job (from /admin/metadata-health/repair-progress). */
interface RepairProgress {
  running: boolean;
  /** True when the job claimed to be running but produced no update for 30+ min
   *  (its promise hung — the run never resolved). Safe to re-run. */
  stalled?: boolean;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  remapped?: number;
  legacyQuarantined?: number;
  episodesRemoved?: number;
  transferred?: number;
  candidates?: number;
  activated?: number;
  blocked?: number;
  current?: string;
  finishedAt?: string;
  report?: {
    mode: 'dry-run' | 'repair';
    nextCursor: string | null;
    scanned: number;
    candidates: number;
    activated: number;
    blocked: number;
    results?: unknown[];
    targeted?: boolean;
  };
}

interface CanonicalizationStats {
  active: number;
  copying: number;
  failed: number;
  scanEligible: number;
  scanCursor: string | null;
}

const REPAIR_LABELS: Record<string, string> = {
  'character-ids': 'Character IDs backfill',
  'anime-rehydrate': 'Anime → TVDB rehydration',
  'tvdb-id-conflicts': 'TVDB ID conflict repair',
  'wrong-kind-external-ids': 'Wrong-kind external ID repair',
  'provider-duplicates': 'Provider duplicate movie repair',
  'english-base': 'English base restore',
  'english-content': 'English content verify',
  'banner-posters': 'Banner poster repair',
  ratings: 'Rating backfill',
  recommendations: 'Recommendations backfill',
  'movie-countries': 'Movie countries backfill',
  'cast-dedup': 'Cast dedup',
  'structure-reconcile': 'Structure reconcile',
  'media-canonicalization': 'Cross-media canonicalization',
};

/** One-line guidance per stat: what it means and what to do about it. */
const STAT_HINTS: Record<string, string> = {
  total: 'All media rows in the local catalog (shows + movies).',
  neverHydrated:
    'Rows whose metadata refresh timestamp is null. They may contain partial provider data; Run Backfill completes them.',
  showsMissingEpisodes:
    'Shows with zero seasons/episodes stored. Run Backfill to rehydrate their structure.',
  moviesMissingOverview: 'Movies missing their description text. Run Backfill to fill it.',
  tvdbOnly:
    'Correct-kind TVDB identities with no verified TMDB identity. This combines legitimate TVDB-only fallback shows and movie identity backlog; the split is shown on the card.',
  stale: 'Metadata older than 30 days. These refresh lazily on view; Run Backfill for a bulk pass.',
  animeOnTmdb:
    'Strict anime shows (TMDB Animation genre plus the anime keyword) whose active structure contradicts their TVDB owner. Fix remaps user data onto TVDB structure. Unresolvable identities are parked for 30 days; legacy quarantines are not active contamination.',
  structuralTypeMismatch:
    'Movie and show merged into ONE row by a bad id cross-link. Repair splits them and transfers watch data.',
  castMissingCharacterIds:
    'Actionable cast-only refreshes: pending show imports, TVDB-owned casts missing character ids, the old top-20 slice, and pending movie votes. Shows require a correct-kind TVDB series id. Movies keep TMDB metadata canonical and add only role aliases or supplemental cast rows proven through TVDB character/person/movie cross-identity. Pending votes replay automatically after a successful authoritative refresh.',
  pendingCharacterVotes:
    'Character-vote import rows still waiting for a TVDB role identity, split into shows and movies below. Cast-only enrichment automatically replays completed imports. Provider failures stay pending; only a successful authoritative refresh may audit a missing role as skipped.',
  movieDataOnShows:
    'Movie statuses/history wrongly written on shows (import bug). The Repair button above purges these too.',
  multiTvdbIds:
    'Same-kind TVDB alias sets needing verification. Raw aliases remain visible, but unchanged benign sets are permanently parked, unresolved sets for 90 days, and ambiguous sets for 180 days. Shows verify through TMDB; movies use TVDB remote TMDB/IMDb ids. Repair detaches only proven conflicts and never deletes user data.',
  wrongKindExternalIds:
    'Provider aliases stored in the wrong namespace (MOVIE on a SHOW or SERIES on a MOVIE). Repair detaches them only when a correct-kind TMDB/IMDb/TVDB identity anchors the row. Unanchored rows remain for manual review; user data is untouched.',
  authority:
    'Typed structural authority health. Missing or invalid ownership is unsafe; outdated rule versions need an authority reconcile pass. Supplemental provider aliases do not count as mixed structure.',
  legacyStructure:
    'Episodes quarantined because canonical remapping was ambiguous. They retain user data and direct accessibility, but are excluded from active seasons, progress, counts, watch-next, aggregates, imports, and structure health.',
  providerDuplicateMovies:
    'Movie rows with TVDB/IMDb identity but no TMDB id. This is a candidate backlog, not a guaranteed duplicate count. Resolution is IMDb-first, then TVDB verified remote ids, then exact title+year and conservative metadata fallback. Dry-run reports merge/attach/skip evidence. Repair preserves statuses, history, ratings, reactions, lists, comments, reviews, and watch-provider alerts. Ambiguous matches are skipped.',
  nonEnglishBase:
    "Rows explicitly marked as having a non-English base title (title_locale ≠ en). Repair re-hydrates them with a proper English base and restores the 'en' override. Rows that just failed are parked for 24h so repeated runs keep advancing. Rows with an unset marker are NOT counted (most have a fine English base already). No user data touched.",
  nonEnglishContent:
    "Suspected wrong-language CONTENT with a lying/missing marker: the title/overview an English user sees contains non-ASCII, or episode title/overview contains several non-ASCII letter-like characters. Verify+Fix checks the most-popular suspects first against the provider's canonical English title/overview and re-hydrates only real media mismatches; episode suspects rehydrate the parent show in English. Verified rows are remembered and leave this count (content changes re-arm them), so the number DRAINS as runs complete. Rows that fail are parked for 24h so normal runs keep advancing. Deep mode verifies every row — catches pure-ASCII foreign media titles/overviews — and shows its own backlog/cursor stats when selected. A nightly Scheduled Job keeps it converged. No user data touched.",
  bannerAsPoster:
    'Rows whose poster is actually a TVDB BANNER (wide artwork in a poster slot), or whose TVDB artwork URL has a duplicated host prefix. Repair normalizes malformed TVDB URLs first, then re-hydrates true banner-as-poster rows from TVDB so the corrected mapper re-picks poster type 2/backdrop type 3. Most-visible first, stops early on TVDB rate limits. No user data touched.',
  missingRating:
    'Rows whose supplemental TMDB community rating is missing or due for refresh. TVDB exposes no equivalent public 0–10 community rating, so TVDB-owned shows keep TVDB metadata/structure while TMDB supplies vote_average when a verified TMDB identity exists. Backfill resolves the stored TMDB id, else the TVDB-to-TMDB identity chain, else the IMDb identity chain; it records provider provenance and refresh timestamps. A checked source with no current value retains the last known rating. Most-popular first, stops on rate limits. No user rating data touched.',
  recommendationsMissing:
    'TMDB-linked rows whose "similar shows/movies" recommendations were never synced (rows hydrated before recommendations existed, or TVDB-hydrated rows — TVDB supplies none). Backfill fetches TMDB /recommendations per row with ONE light call (no rehydration), most-popular first, stopping early on TMDB rate limits. Rows whose provider has no recommendations are stamped as checked and leave the count. No user data touched.',
  moviesMissingCountry:
    'TMDB-linked movie rows with no production country — the explore country filter can only match movies whose country is known. Backfill resolves TMDB production_countries per row with ONE light call, most-popular first, stopping early on rate limits. Rows TMDB has no country for are stamped as checked and skipped for 90 days. No user data touched.',
  castDuplicates:
    'Duplicate cast credits created when TVDB people ids were stored under the TMDB_ id namespace, by unstable fallback ids, or by concurrent hydrations — the same person appears twice. Dedup auto-merges groups that are provably the same person+role on one title: same cast-member record, same TVDB character id, the same normalized actor+character name (including "/" and quote variants), or SIMILAR character names across DIFFERENT providers (one contains the other at a word boundary — "Juliette" vs "Juliette Nichols", "Daemon Targaryen" vs "Prince Daemon Targaryen"). Same-provider near-duplicates are kept (may be two genuine roles, e.g. "Goku" vs "Goku Jr."). Votes are re-pointed to the surviving row BEFORE anything is deleted, so character votes are never lost. Run Report first, then Dry-run for exact counts, then Repair. Anything left can be merged manually per title via the inspect box below.',
  dualStructureShows:
    'Shows that currently contain active episode rows from the wrong provider for their persisted structural owner. This is the real mixed-graph count; the separate Authority Outdated card tracks shows that merely need the current ownership rule re-evaluated. Repair rehydrates from the owner and preserves user data.',
  mediaCanonicalization:
    'General TVDB-owned aggregates eligible for duplicate/component evaluation. Dry-runs advance with a stable cursor and report the chosen root plus direct or transitive identity evidence. Repair copies and verifies the complete canonical family in one transaction; failed/copying sources stay visible and never cut over.',
};

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  GENERAL: { label: 'General', color: 'default' },
  ANIME: { label: 'Anime', color: 'info' },
  MANGA: { label: 'Manga', color: 'warning' },
  UNKNOWN: { label: 'Unclassified', color: 'default' },
};

export default function MetadataHealthPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<MetadataHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [healthNotice, setHealthNotice] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const healthRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [fixingAnime, setFixingAnime] = useState(false);
  const [animeResult, setAnimeResult] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<string | null>(null);
  const [backfillingCast, setBackfillingCast] = useState(false);
  const [castResult, setCastResult] = useState<string | null>(null);
  const [repairingTvdbIds, setRepairingTvdbIds] = useState(false);
  const [tvdbIdResult, setTvdbIdResult] = useState<string | null>(null);
  const [repairingWrongKindIds, setRepairingWrongKindIds] = useState(false);
  const [wrongKindIdResult, setWrongKindIdResult] = useState<string | null>(null);
  const [repairingProviderDuplicates, setRepairingProviderDuplicates] = useState(false);
  const [providerDuplicateResult, setProviderDuplicateResult] = useState<string | null>(null);
  const [providerDuplicateCount, setProviderDuplicateCount] = useState('200');
  const [repairingEnBase, setRepairingEnBase] = useState(false);
  const [enBaseResult, setEnBaseResult] = useState<string | null>(null);
  const [enBaseCount, setEnBaseCount] = useState('200');
  const [repairingEnContent, setRepairingEnContent] = useState(false);
  const [enContentResult, setEnContentResult] = useState<string | null>(null);
  const [enContentCount, setEnContentCount] = useState('500');
  const [enContentStats, setEnContentStats] = useState(false);
  const [enContentDeep, setEnContentDeep] = useState(false);
  const [repairingBanner, setRepairingBanner] = useState(false);
  const [bannerResult, setBannerResult] = useState<string | null>(null);
  const [bannerCount, setBannerCount] = useState('500');
  const [repairingRatings, setRepairingRatings] = useState(false);
  const [ratingResult, setRatingResult] = useState<string | null>(null);
  const [ratingCount, setRatingCount] = useState('500');
  const [repairingRecs, setRepairingRecs] = useState(false);
  const [recsResult, setRecsResult] = useState<string | null>(null);
  const [recsCount, setRecsCount] = useState('500');
  const [repairingCountries, setRepairingCountries] = useState(false);
  const [countriesResult, setCountriesResult] = useState<string | null>(null);
  const [countriesCount, setCountriesCount] = useState('500');
  const [castCount, setCastCount] = useState('500');
  const [dedupRunning, setDedupRunning] = useState(false);
  const [dedupResult, setDedupResult] = useState<string | null>(null);
  const [dedupCount, setDedupCount] = useState('500');
  const [reconCount, setReconCount] = useState('200');
  const [reconMediaId, setReconMediaId] = useState('');
  const [reconTargeted, setReconTargeted] = useState(false);
  const [dedupInspectId, setDedupInspectId] = useState('');
  const [dedupInspecting, setDedupInspecting] = useState(false);
  const [dedupReview, setDedupReview] = useState<{
    titles?: { mediaId: string; title: string }[];
    review: {
      mediaId: string;
      title: string;
      rows: { id: string; member: string; character: string | null; votes: number }[];
    }[];
    groupsHigh?: number;
    groupsMedium?: number;
  } | null>(null);
  const [mergingPair, setMergingPair] = useState(false);
  const [reconRunning, setReconRunning] = useState(false);
  const [reconResult, setReconResult] = useState<string | null>(null);
  const [canonicalStats, setCanonicalStats] = useState<CanonicalizationStats>({
    active: 0,
    copying: 0,
    failed: 0,
    scanEligible: 0,
    scanCursor: null,
  });
  const [canonicalRunning, setCanonicalRunning] = useState(false);
  const [canonicalResult, setCanonicalResult] = useState<string | null>(null);
  const [canonicalCount, setCanonicalCount] = useState('25');
  const [canonicalMediaId, setCanonicalMediaId] = useState('');
  const [canonicalDryRunCursor, setCanonicalDryRunCursor] = useState('');
  const [repairs, setRepairs] = useState<Record<string, RepairProgress>>({});
  const canonicalReportHandledRef = useRef<string | null>(null);
  const [batchCount, setBatchCount] = useState('200');
  const [batchRps, setBatchRps] = useState('');
  const [syncStart, setSyncStart] = useState('');

  const canView = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => {
    if (healthRetryRef.current) {
      clearTimeout(healthRetryRef.current);
      healthRetryRef.current = null;
    }
    setLoading(true);
    setHealthError(null);
    api
      .get('/admin/media-canonicalization/stats')
      .then((r) => setCanonicalStats(r.data))
      .catch(() => undefined);
    const params = new URLSearchParams();
    if (enContentStats) params.set('content', '1');
    if (enContentDeep) params.set('deep', '1');
    const qs = params.toString();
    api
      .get(`/admin/metadata-health${qs ? `?${qs}` : ''}`)
      .then((r) => {
        const health = r.data?._health as
          { status?: string; stale?: boolean; computedAt?: string | null } | undefined;
        if (typeof r.data?.total === 'number') setStats(r.data);
        if (health?.status === 'refreshing') {
          setHealthNotice(
            health.stale
              ? `Showing the snapshot from ${health.computedAt ? new Date(health.computedAt).toLocaleString() : 'the last run'} while production metrics refresh.`
              : 'Calculating the first metadata-health snapshot in the background…',
          );
          healthRetryRef.current = setTimeout(() => load(), 3000);
        } else {
          setHealthNotice(null);
        }
      })
      .catch((error) => {
        setHealthError(
          error?.response?.data?.message ??
            error?.message ??
            'Metadata health could not be loaded.',
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (canView) load();
  }, [canView, enContentStats, enContentDeep]);

  useEffect(
    () => () => {
      if (healthRetryRef.current) clearTimeout(healthRetryRef.current);
    },
    [],
  );

  // Live repair progress — poll every 3s while the page is open.
  useEffect(() => {
    if (!canView) return;
    const loadRepairs = () =>
      api
        .get('/admin/metadata-health/repair-progress')
        .then((r) => {
          const progress = r.data as Record<string, RepairProgress>;
          setRepairs(progress);
          const canonical = progress['media-canonicalization'];
          if (
            canonical?.finishedAt &&
            canonical.report &&
            canonicalReportHandledRef.current !== canonical.finishedAt
          ) {
            canonicalReportHandledRef.current = canonical.finishedAt;
            const report = canonical.report;
            if (report.mode === 'dry-run' && !report.targeted) {
              setCanonicalDryRunCursor(report.nextCursor ?? '');
            }
            setCanonicalResult(
              `Scanned ${report.scanned}; candidates ${report.candidates}; activated ${report.activated}; blocked ${report.blocked}; next cursor ${report.nextCursor ?? 'end of pass'}. ${JSON.stringify(report.results ?? [])}`,
            );
            load();
          }
        })
        .catch(() => undefined);
    loadRepairs();
    const id = setInterval(loadRepairs, 3000);
    return () => clearInterval(id);
  }, [canView]);

  const runBackfill = () => {
    setBackfilling(true);
    setBackfillResult(null);
    api
      .post(`/admin/metadata-backfill/run?count=${batchCount}${batchRps ? `&rps=${batchRps}` : ''}`)
      .then(() => {
        setBackfillResult(
          `Backfill started (${batchCount} items${batchRps ? `, ${batchRps}/min` : ', full speed'}). Stats refresh in 30s.`,
        );
        setTimeout(() => load(), 30000); // auto-refresh stats after 30s
      })
      .catch(() => setBackfillResult('Backfill failed to start.'))
      .finally(() => setBackfilling(false));
  };

  const runTmdbSync = () => {
    setSyncing(true);
    setSyncResult(null);
    const qs = syncStart ? `?start=${syncStart}` : '';
    api
      .post(`/admin/tmdb-changes/run${qs}`)
      .then(() => {
        setSyncResult(
          syncStart
            ? `TMDB changes sync (custom range from ${syncStart}) started in background. The daily cursor is untouched. Stats refresh in 60s.`
            : 'TMDB changes sync started in background. Check API logs for results.',
        );
        setTimeout(() => load(), 60000); // auto-refresh after 60s (sync takes longer)
      })
      .catch(() => setSyncResult('TMDB sync failed to start.'))
      .finally(() => setSyncing(false));
  };

  const runAnimeFix = () => {
    setFixingAnime(true);
    setAnimeResult(null);
    api
      .post('/admin/anime-tvdb-rehydrate/run')
      .then(() => {
        setAnimeResult('Anime TVDB rehydration started in background. Stats refresh in 30s.');
        setTimeout(() => load(), 30000); // auto-refresh stats after 30s
      })
      .catch(() => setAnimeResult('Anime TVDB rehydration failed to start.'))
      .finally(() => setFixingAnime(false));
  };

  const runTypeRepair = () => {
    setRepairing(true);
    setRepairResult(null);
    api
      .post('/admin/repair-type-mismatch/run')
      .then(() => {
        setRepairResult('Type mismatch repair started in background. Stats refresh in 30s.');
        setTimeout(() => load(), 30000);
      })
      .catch(() => setRepairResult('Type mismatch repair failed to start.'))
      .finally(() => setRepairing(false));
  };

  const runCastBackfill = () => {
    setBackfillingCast(true);
    setCastResult(null);
    const n = Math.max(1, Number(castCount) || 500);
    api
      .post(`/admin/cast-character-ids/run?count=${n}`)
      .then(() => {
        setCastResult(`Cast character-id backfill started (${n} shows). Stats refresh in 30s.`);
        setTimeout(() => load(), 30000);
      })
      .catch(() => setCastResult('Cast backfill failed to start.'))
      .finally(() => setBackfillingCast(false));
  };

  const runCastDedup = (mode: 'report' | 'dry-run' | 'repair') => {
    if (
      mode === 'repair' &&
      !window.confirm(
        'Merge HIGH-confidence duplicate cast rows? Votes are re-pointed to the surviving row before anything is deleted. Run Report and Dry-run first and review the counts.',
      )
    ) {
      return;
    }
    setDedupRunning(true);
    setDedupResult(null);
    const n = Math.max(1, Number(dedupCount) || 500);
    api
      .post(`/admin/cast-dedup/run?mode=${mode}&count=${n}`)
      .then(() => {
        setDedupResult(
          `Cast dedup (${mode}, max ${n} titles) started in background. Stats refresh in 30s — watch the Cast Dedup progress row above.`,
        );
        setTimeout(() => load(), 30000);
      })
      .catch(() => setDedupResult('Cast dedup failed to start.'))
      .finally(() => setDedupRunning(false));
  };

  /** Targeted report for ONE title — returns the review rows synchronously so the
   *  admin can merge name-only pairs (e.g. "Matt Murdock" vs "Matt Murdock / Daredevil"). */
  const inspectCastDedup = () => {
    const mediaId = dedupInspectId.trim();
    if (!mediaId) return;
    setDedupInspecting(true);
    setDedupReview(null);
    setDedupResult(null);
    api
      .post(`/admin/cast-dedup/run?mode=report&mediaId=${encodeURIComponent(mediaId)}`)
      .then((r) => {
        setDedupReview(r.data);
        if (!(r.data?.review ?? []).length) {
          setDedupResult('No name-only duplicate groups on this title (nothing to review).');
        }
      })
      .catch((e) => setDedupResult(`Inspect failed: ${e?.response?.data?.message ?? 'error'}`))
      .finally(() => setDedupInspecting(false));
  };

  const mergeCastPair = (mediaId: string, keepCastId: string, mergeCastId: string) => {
    if (
      !window.confirm(
        'Merge the second row into the kept row? Votes are re-pointed before the duplicate is deleted. This cannot be undone.',
      )
    ) {
      return;
    }
    setMergingPair(true);
    api
      .post('/admin/cast-dedup/merge', { mediaId, keepCastId, mergeCastId })
      .then((r) => {
        setDedupResult(
          `Merged: ${r.data.votesMoved} vote(s) moved, ${r.data.rowsDeleted} row(s) deleted. Re-inspecting…`,
        );
        inspectCastDedup();
      })
      .catch((e) => setDedupResult(`Merge failed: ${e?.response?.data?.message ?? 'error'}`))
      .finally(() => setMergingPair(false));
  };

  const runStructureReconcile = (mode: 'report' | 'dry-run' | 'repair') => {
    if (
      mode === 'repair' &&
      !window.confirm(
        'Reconcile mixed-provider season structures using each show’s persisted canonical owner, transferring or quarantining all user data? Run Report and Dry-run first and review the matches.',
      )
    ) {
      return;
    }
    setReconRunning(true);
    setReconResult(null);
    const n = Math.max(1, Number(reconCount) || 200);
    api
      .post(`/admin/structure-reconcile/run?mode=${mode}&count=${n}`)
      .then(() => {
        setReconResult(
          `Structure reconcile (${mode}, max ${n} titles) started in background. Stats refresh in 30s — watch the Structure Reconcile progress row above.`,
        );
        setTimeout(() => load(), 30000);
      })
      .catch(() => setReconResult('Structure reconcile failed to start.'))
      .finally(() => setReconRunning(false));
  };

  /** Targeted reconcile for ONE title (awaited — returns the action taken). */
  const runStructureReconcileTargeted = (mode: 'dry-run' | 'repair') => {
    const mediaId = reconMediaId.trim();
    if (!mediaId) return;
    if (
      mode === 'repair' &&
      !window.confirm(
        'Run the full canonical-owner structure repair for this title, transferring or quarantining all user data? Run Dry-run first and review the matches.',
      )
    ) {
      return;
    }
    setReconTargeted(true);
    setReconResult(null);
    api
      .post(`/admin/structure-reconcile/run?mode=${mode}&mediaId=${encodeURIComponent(mediaId)}`)
      .then((r) => {
        const t = r.data?.titles?.[0];
        const remap = t?.remap
          ? ` — mapped ${t.remap.mapped}, transferred ${t.remap.transferred}, deleted ${t.remap.episodesRemoved} episodes/${t.remap.seasonsRemoved} seasons, legacy ${t.remap.legacyQuarantined}, unmapped ${t.remap.unmapped}, confidence ${JSON.stringify(t.mappingConfidence)}, rules ${JSON.stringify(t.remap.matchRules)}`
          : '';
        const missing = t?.missingProviderIds?.length
          ? `; missing IDs ${t.missingProviderIds.join(', ')}`
          : '';
        setReconResult(
          t
            ? `${t.title}: ${t.action} (${String(t.structureProvider ?? 'unknown').toUpperCase()}/${t.authorityReason ?? 'unknown'}${missing}; stale ${t.stale}, fresh ${t.fresh}; failures ${r.data?.failed ?? 0}; remaining ${r.data?.remainingBacklog ?? '?'})${remap}`
            : `Done: ${JSON.stringify(r.data)}`,
        );
        setTimeout(() => load(), 10000);
      })
      .catch((e) =>
        setReconResult(`Targeted reconcile failed: ${e?.response?.data?.message ?? 'error'}`),
      )
      .finally(() => setReconTargeted(false));
  };

  const runMediaCanonicalization = (mode: 'dry-run' | 'repair', targeted = false) => {
    const mediaId = canonicalMediaId.trim();
    if (targeted && !mediaId) return;
    if (
      mode === 'repair' &&
      !window.confirm(
        'Copy and verify user data into the canonical show, then hide/redirect each proven source only after the verification gate passes?',
      )
    ) {
      return;
    }
    setCanonicalRunning(true);
    setCanonicalResult(null);
    const count = Math.max(1, Number(canonicalCount) || 25);
    const query = targeted
      ? `mode=${mode}&mediaId=${encodeURIComponent(mediaId)}`
      : `mode=${mode}&count=${count}${
          mode === 'dry-run' && canonicalDryRunCursor
            ? `&cursor=${encodeURIComponent(canonicalDryRunCursor)}`
            : ''
        }`;
    api
      .post(`/admin/media-canonicalization/run?${query}`)
      .then((r) => {
        setCanonicalResult(
          r.data?.message ??
            `Canonicalization (${mode}) started in background. Watch Repair progress above.`,
        );
        if (r.data?.started !== false) {
          setRepairs((previous) => ({
            ...previous,
            'media-canonicalization': {
              running: true,
              processed: 0,
              total: targeted ? 1 : count,
              succeeded: 0,
              failed: 0,
              candidates: 0,
              activated: 0,
              blocked: 0,
              current: targeted ? mediaId : `Preparing ${mode} batch`,
            },
          }));
        }
      })
      .catch((e) =>
        setCanonicalResult(
          `Canonicalization failed: ${e?.response?.data?.message ?? e?.message ?? 'error'}`,
        ),
      )
      .finally(() => setCanonicalRunning(false));
  };

  const runTvdbIdRepair = (mode: 'dry-run' | 'repair') => {
    setRepairingTvdbIds(true);
    setTvdbIdResult(null);
    api
      .post(`/admin/repair-tvdb-id-conflicts/run?mode=${mode}`)
      .then((r) => {
        if (mode === 'dry-run') {
          setTvdbIdResult(
            `Dry-run: ${r.data.conflictsFixed} conflicts, ${r.data.idsDetached} ids would detach, ${r.data.mergedKept} retained, ${r.data.ambiguous.length} ambiguous. ${JSON.stringify(r.data.outcomes.slice(0, 20))}`,
          );
        } else {
          setTvdbIdResult('TVDB id-conflict repair started in background. Stats refresh in 60s.');
          setTimeout(() => load(), 60000);
        }
      })
      .catch(() => setTvdbIdResult('TVDB id-conflict repair failed to start.'))
      .finally(() => setRepairingTvdbIds(false));
  };

  const runWrongKindIdRepair = (mode: 'dry-run' | 'repair') => {
    setRepairingWrongKindIds(true);
    setWrongKindIdResult(null);
    api
      .post(`/admin/repair-wrong-kind-external-ids/run?mode=${mode}`)
      .then((r) => {
        if (mode === 'dry-run') {
          setWrongKindIdResult(
            `Dry-run: ${r.data.detached} aliases would detach, ${r.data.ambiguous} media need review. ${JSON.stringify(r.data.outcomes.slice(0, 20))}`,
          );
        } else {
          setWrongKindIdResult('Wrong-kind external ID repair started. Stats refresh in 30s.');
          setTimeout(() => load(), 30000);
        }
      })
      .catch(() => setWrongKindIdResult('Wrong-kind external ID repair failed to start.'))
      .finally(() => setRepairingWrongKindIds(false));
  };

  const runProviderDuplicateRepair = (mode: 'dry-run' | 'repair') => {
    setRepairingProviderDuplicates(true);
    setProviderDuplicateResult(null);
    const n = Math.max(1, Number(providerDuplicateCount) || 200);
    api
      .post(`/admin/repair-provider-duplicates/run?count=${n}&mode=${mode}`)
      .then((r) => {
        if (mode === 'dry-run') {
          setProviderDuplicateResult(
            `Dry-run: ${r.data.merged} would merge, ${r.data.attached} would attach, ${r.data.skipped} skipped, ${r.data.failed} failed. ${JSON.stringify(r.data.outcomes.slice(0, 20))}`,
          );
        } else {
          setProviderDuplicateResult(
            `Movie identity repair started (${n} rows). Stats refresh in 60s.`,
          );
          setTimeout(() => load(), 60000);
        }
      })
      .catch(() => setProviderDuplicateResult('Provider duplicate repair failed to start.'))
      .finally(() => setRepairingProviderDuplicates(false));
  };

  const runEnBaseRepair = () => {
    setRepairingEnBase(true);
    setEnBaseResult(null);
    const n = Math.max(1, Number(enBaseCount) || 200);
    api
      .post(`/admin/repair-non-english-base/run?count=${n}`)
      .then(() => {
        setEnBaseResult(`Non-English base repair started (${n} rows). Stats refresh in 60s.`);
        setTimeout(() => load(), 60000);
      })
      .catch(() => setEnBaseResult('Non-English base repair failed to start.'))
      .finally(() => setRepairingEnBase(false));
  };

  const runEnContentRepair = () => {
    setRepairingEnContent(true);
    setEnContentResult(null);
    const n = Math.max(1, Number(enContentCount) || 500);
    api
      .post(`/admin/repair-english-content/run?count=${n}${enContentDeep ? '&deep=1' : ''}`)
      .then(() => {
        setEnContentResult(
          `English-content verify+repair started (${n} rows${enContentDeep ? ', deep scan' : ''}). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setEnContentResult('English-content repair failed to start.'))
      .finally(() => setRepairingEnContent(false));
  };

  const runBannerRepair = () => {
    setRepairingBanner(true);
    setBannerResult(null);
    const n = Math.max(1, Number(bannerCount) || 500);
    api
      .post(`/admin/repair-banner-posters/run?count=${n}`)
      .then(() => {
        setBannerResult(
          `Banner-poster repair started (${n} rows). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setBannerResult('Banner-poster repair failed to start.'))
      .finally(() => setRepairingBanner(false));
  };

  const runRatingBackfill = () => {
    setRepairingRatings(true);
    setRatingResult(null);
    const n = Math.max(1, Number(ratingCount) || 500);
    api
      .post(`/admin/backfill-ratings/run?count=${n}`)
      .then(() => {
        setRatingResult(
          `Rating backfill started (${n} rows). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setRatingResult('Rating backfill failed to start.'))
      .finally(() => setRepairingRatings(false));
  };

  const runRecsBackfill = () => {
    setRepairingRecs(true);
    setRecsResult(null);
    const n = Math.max(1, Number(recsCount) || 500);
    api
      .post(`/admin/repair-recommendations/run?count=${n}`)
      .then(() => {
        setRecsResult(
          `Recommendations backfill started (${n} rows). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setRecsResult('Recommendations backfill failed to start.'))
      .finally(() => setRepairingRecs(false));
  };

  const runCountriesBackfill = () => {
    setRepairingCountries(true);
    setCountriesResult(null);
    const n = Math.max(1, Number(countriesCount) || 500);
    api
      .post(`/admin/repair-movie-countries/run?count=${n}`)
      .then(() => {
        setCountriesResult(
          `Movie country backfill started (${n} rows). Watch the progress panel above; stats refresh in 60s.`,
        );
        setTimeout(() => load(), 60000);
      })
      .catch(() => setCountriesResult('Movie country backfill failed to start.'))
      .finally(() => setRepairingCountries(false));
  };

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  const pct = (n: number) => (stats && stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);
  const deepStats = stats?.nonEnglishContentDeep;
  const deepCursorPct =
    deepStats && deepStats.totalEligible > 0
      ? Math.min(100, Math.round((deepStats.cursorPosition / deepStats.totalEligible) * 100))
      : 0;
  const enContentLoaded = stats?.nonEnglishContent !== null;
  const canonicalBusy = canonicalRunning || repairs['media-canonicalization']?.running === true;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metadata Health</h1>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={load} className="text-sm text-blue-600 hover:underline">
            Refresh
          </button>
          <span className="text-xs text-zinc-400">TMDB sync from:</span>
          <input
            type="date"
            value={syncStart}
            onChange={(e) => setSyncStart(e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
          />
          <button
            onClick={runTmdbSync}
            disabled={syncing}
            className="rounded border border-blue-600 px-3 py-1 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : syncStart ? 'Sync (custom range)' : 'TMDB Changes Sync'}
          </button>
          <button
            onClick={runBackfill}
            disabled={backfilling}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {backfilling ? 'Running…' : `Run Backfill`}
          </button>
          <input
            type="number"
            value={batchCount}
            onChange={(e) => setBatchCount(e.target.value)}
            className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
            placeholder="200"
          />
          <span className="text-xs text-zinc-400">items/min:</span>
          <input
            type="number"
            value={batchRps}
            onChange={(e) => setBatchRps(e.target.value)}
            className="w-16 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-600 dark:bg-zinc-800"
            placeholder="full"
          />
        </div>
      </div>

      {healthNotice && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {healthNotice}
        </div>
      )}
      {healthError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          Metadata health failed to load: {healthError}
        </div>
      )}

      {syncResult && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200">
          {syncResult}
        </div>
      )}
      {backfillResult && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {backfillResult}
        </div>
      )}
      {animeResult && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-200">
          {animeResult}
        </div>
      )}
      {repairResult && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-sm text-purple-800 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-200">
          {repairResult}
        </div>
      )}
      {castResult && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {castResult}
        </div>
      )}
      {tvdbIdResult && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          {tvdbIdResult}
        </div>
      )}
      {wrongKindIdResult && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          {wrongKindIdResult}
        </div>
      )}
      {providerDuplicateResult && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
          {providerDuplicateResult}
        </div>
      )}
      {enBaseResult && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
          {enBaseResult}
        </div>
      )}
      {enContentResult && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {enContentResult}
        </div>
      )}
      {bannerResult && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
          {bannerResult}
        </div>
      )}
      {ratingResult && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {ratingResult}
        </div>
      )}
      {recsResult && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {recsResult}
        </div>
      )}
      {countriesResult && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-200">
          {countriesResult}
        </div>
      )}
      {dedupResult && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200">
          {dedupResult}
        </div>
      )}
      {reconResult && (
        <div className="rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-sm text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">
          {reconResult}
        </div>
      )}

      {/* Manual cast-merge review (name-only duplicate pairs of one inspected title) */}
      {dedupReview && (dedupReview.review ?? []).length > 0 && (
        <div className="rounded-lg border border-violet-200 p-4 dark:border-violet-800">
          <h2 className="mb-1 font-medium">Cast duplicates — manual review</h2>
          <p className="mb-3 text-xs text-zinc-500">
            Name-only matches are never auto-merged. Pick which row survives; votes on the other row
            are re-pointed before it is deleted.
          </p>
          {dedupReview.review.map((g) => (
            <div
              key={g.mediaId}
              className="mb-3 rounded border border-zinc-200 p-3 dark:border-zinc-700"
            >
              <p className="mb-2 text-sm font-medium">{g.title}</p>
              <div className="space-y-1">
                {g.rows.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>
                      {r.member} — {r.character ?? '(no character)'}
                      <span className="ml-2 text-xs text-zinc-400">{r.votes} vote(s)</span>
                    </span>
                    <button
                      onClick={() =>
                        mergeCastPair(
                          g.mediaId,
                          r.id,
                          g.rows.find((o) => o.id !== r.id)?.id ?? r.id,
                        )
                      }
                      disabled={mergingPair || g.rows.length !== 2}
                      className="shrink-0 rounded border border-violet-600 px-2 py-1 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-50"
                    >
                      Keep this row
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Live repair progress (polls every 3s; finished jobs stay visible ~60s) */}
      {Object.keys(repairs).length > 0 && (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-medium">Repair progress</h2>
          <div className="space-y-3">
            {Object.entries(repairs).map(([job, p]) => {
              const pctDone =
                p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
              const canonicalCounts =
                job === 'media-canonicalization'
                  ? ` · ${p.candidates ?? 0} candidates / ${p.activated ?? 0} activated / ${p.blocked ?? 0} blocked`
                  : '';
              return (
                <div key={job}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      {REPAIR_LABELS[job] ?? job}
                      {p.stalled ? (
                        <span className="ml-2 text-xs font-normal text-red-600 dark:text-red-400">
                          stalled — no progress for 30+ min (hung run); safe to re-run
                        </span>
                      ) : (
                        !p.running && (
                          <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400">
                            done
                          </span>
                        )
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {p.processed}/{p.total} · {p.succeeded} ok / {p.failed} fail
                      {canonicalCounts}
                      {job === 'structure-reconcile' && (
                        <>
                          {' '}
                          · {p.remapped ?? 0} mapped / {p.legacyQuarantined ?? 0} legacy /{' '}
                          {p.episodesRemoved ?? 0} removed / {p.transferred ?? 0} data moved
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
                    <div
                      className={`h-2 rounded transition-all ${p.stalled ? 'bg-red-600' : p.running ? 'bg-blue-600' : 'bg-green-600'}`}
                      style={{ width: `${p.total > 0 ? pctDone : p.running ? 5 : 100}%` }}
                    />
                  </div>
                  {p.running && p.current && (
                    <p className="mt-0.5 truncate text-xs text-zinc-400">{p.current}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading || (!stats && !healthError) ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : stats ? (
        <>
          {/* Health metrics */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <MetricCard label="Total Media" value={stats.total} hint={STAT_HINTS.total} />
            <MetricCard
              label="Never Hydrated"
              value={stats.neverHydrated}
              sub={`${pct(stats.neverHydrated)}% of total`}
              hint={STAT_HINTS.neverHydrated}
              highlight={stats.neverHydrated > 0}
            />
            <MetricCard
              label="Shows Missing Episodes"
              value={stats.showsMissingEpisodes}
              sub={`${pct(stats.showsMissingEpisodes)}% of total`}
              hint={STAT_HINTS.showsMissingEpisodes}
              highlight={stats.showsMissingEpisodes > 0}
            />
            <MetricCard
              label="Movies Missing Overview"
              value={stats.moviesMissingOverview}
              sub={`${pct(stats.moviesMissingOverview)}% of total`}
              hint={STAT_HINTS.moviesMissingOverview}
              highlight={stats.moviesMissingOverview > 0}
            />
            <MetricCard
              label="TVDB-Only (no TMDB)"
              value={stats.tvdbOnly}
              sub={`${stats.tvdbFallbackShows.toLocaleString()} fallback shows · ${stats.providerDuplicateMovies.toLocaleString()} actionable movie identity candidates`}
              hint={STAT_HINTS.tvdbOnly}
            />
            <MetricCard
              label="Stale (30+ days)"
              value={stats.stale}
              sub={`${pct(stats.stale)}% of total`}
              hint={STAT_HINTS.stale}
              highlight={stats.stale > 0}
            />
            <MetricCard
              label="Anime on TMDB"
              value={stats.animeOnTmdb}
              sub={`should be TVDB · ${stats.animeOnTmdbNoTvdbId} missing TVDB id · ${stats.animeTvdbUnresolvable} parked (unresolvable)`}
              hint={STAT_HINTS.animeOnTmdb}
              highlight={stats.animeOnTmdb > 0}
              action={
                <button
                  onClick={runAnimeFix}
                  disabled={fixingAnime}
                  className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  {fixingAnime ? 'Starting…' : 'Fix Anime → TVDB'}
                </button>
              }
            />
            <MetricCard
              label="Type Mismatch"
              value={stats.structuralTypeMismatch}
              sub="movie/show merged into one row"
              hint={STAT_HINTS.structuralTypeMismatch}
              highlight={stats.structuralTypeMismatch > 0}
              action={
                <button
                  onClick={runTypeRepair}
                  disabled={repairing}
                  className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                >
                  {repairing ? 'Starting…' : 'Repair Type Mismatch'}
                </button>
              }
            />
            <MetricCard
              label="Movie Data on Shows"
              value={stats.movieDataOnShows}
              sub="movie statuses/history on shows"
              hint={STAT_HINTS.movieDataOnShows}
              highlight={stats.movieDataOnShows > 0}
            />
            <MetricCard
              label="Cast Missing Character IDs"
              value={stats.castMissingCharacterIds}
              sub={`${stats.pendingCharacterVoteShows.toLocaleString()} shows have pending imported votes`}
              hint={STAT_HINTS.castMissingCharacterIds}
              highlight={stats.castMissingCharacterIds > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={castCount}
                    onChange={(e) => setCastCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Shows per run"
                  />
                  <button
                    onClick={runCastBackfill}
                    disabled={backfillingCast}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {backfillingCast ? 'Starting…' : 'Backfill Character IDs'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Pending Character Votes"
              value={stats.pendingCharacterVoteItems}
              sub={`${stats.pendingCharacterVoteShows.toLocaleString()} shows · ${stats.pendingCharacterVoteMovies.toLocaleString()} movies · ${stats.pendingCharacterVoteShowsWithoutTvdb.toLocaleString()} shows without TVDB identity`}
              hint={STAT_HINTS.pendingCharacterVotes}
              highlight={stats.pendingCharacterVoteItems > 0}
            />
            <MetricCard
              label="Structure Authority"
              value={stats.authorityMissing + stats.authorityInvalid + stats.authorityOutdated}
              sub={`${stats.authorityMissing.toLocaleString()} missing · ${stats.authorityInvalid.toLocaleString()} invalid · ${stats.authorityOutdated.toLocaleString()} outdated`}
              hint={STAT_HINTS.authority}
              highlight={stats.authorityMissing + stats.authorityInvalid > 0}
            />
            <MetricCard
              label="Legacy Unmapped Episodes"
              value={stats.legacyUnmappedEpisodes}
              sub={`${stats.legacyUnmappedShows.toLocaleString()} shows · ${stats.legacyUnmappedWithUserData.toLocaleString()} retain user data`}
              hint={STAT_HINTS.legacyStructure}
            />
            <MetricCard
              label="Duplicate Cast"
              value={stats.castDuplicateMedia ?? 0}
              sub={`${stats.castDuplicateRows ?? 0} excess rows · ${stats.castDuplicateVotes ?? 0} votes on dup rows`}
              hint={STAT_HINTS.castDuplicates}
              highlight={(stats.castDuplicateMedia ?? 0) > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={dedupCount}
                    onChange={(e) => setDedupCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Titles per run"
                  />
                  <button
                    onClick={() => runCastDedup('report')}
                    disabled={dedupRunning}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Report
                  </button>
                  <button
                    onClick={() => runCastDedup('dry-run')}
                    disabled={dedupRunning}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runCastDedup('repair')}
                    disabled={dedupRunning}
                    className="rounded border border-red-600 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {dedupRunning ? 'Starting…' : 'Repair'}
                  </button>
                </div>
              }
            />
            <div className="col-span-full flex items-center gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
              <span className="text-xs text-zinc-500">Manual review (one title):</span>
              <input
                value={dedupInspectId}
                onChange={(e) => setDedupInspectId(e.target.value)}
                placeholder="mediaId"
                className="w-72 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
              />
              <button
                onClick={inspectCastDedup}
                disabled={dedupInspecting || !dedupInspectId.trim()}
                className="rounded border border-violet-600 px-2 py-1 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-50"
              >
                {dedupInspecting ? 'Inspecting…' : 'Inspect name-only pairs'}
              </button>
            </div>
            <MetricCard
              label="Dual Season Structures"
              value={stats.dualStructureShows ?? 0}
              sub="true active provider conflicts (authority backlog excluded)"
              hint={STAT_HINTS.dualStructureShows}
              highlight={(stats.dualStructureShows ?? 0) > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={reconCount}
                    onChange={(e) => setReconCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Titles per run"
                  />
                  <button
                    onClick={() => runStructureReconcile('report')}
                    disabled={reconRunning}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Report
                  </button>
                  <button
                    onClick={() => runStructureReconcile('dry-run')}
                    disabled={reconRunning}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runStructureReconcile('repair')}
                    disabled={reconRunning}
                    className="rounded border border-red-600 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {reconRunning ? 'Starting…' : 'Repair'}
                  </button>
                </div>
              }
            />
            <div className="col-span-full flex items-center gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
              <span className="text-xs text-zinc-500">Targeted (one title):</span>
              <input
                value={reconMediaId}
                onChange={(e) => setReconMediaId(e.target.value)}
                placeholder="mediaId"
                className="w-72 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
              />
              <button
                onClick={() => runStructureReconcileTargeted('dry-run')}
                disabled={reconTargeted || !reconMediaId.trim()}
                className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
              >
                Dry-run
              </button>
              <button
                onClick={() => runStructureReconcileTargeted('repair')}
                disabled={reconTargeted || !reconMediaId.trim()}
                className="rounded border border-red-600 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {reconTargeted ? 'Running…' : 'Repair this title'}
              </button>
            </div>
            <MetricCard
              label="Cross-Media Canonicalization"
              value={(canonicalStats.scanEligible ?? 0).toLocaleString()}
              sub={`${canonicalStats.active.toLocaleString()} active · ${canonicalStats.copying.toLocaleString()} copying · ${canonicalStats.failed.toLocaleString()} failed${canonicalStats.scanCursor ? ' · repair cursor saved' : ''}`}
              hint={STAT_HINTS.mediaCanonicalization}
              highlight={canonicalStats.copying + canonicalStats.failed > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={canonicalCount}
                    onChange={(e) => setCanonicalCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="TVDB aggregate titles per run"
                  />
                  <button
                    onClick={() => runMediaCanonicalization('dry-run')}
                    disabled={canonicalBusy}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runMediaCanonicalization('repair')}
                    disabled={canonicalBusy}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {canonicalBusy ? 'Running...' : 'Copy, verify & activate'}
                  </button>
                </div>
              }
            />
            <div className="col-span-full flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
              <span className="text-xs text-zinc-500">Targeted canonicalization:</span>
              <input
                value={canonicalMediaId}
                onChange={(e) => setCanonicalMediaId(e.target.value)}
                placeholder="TVDB aggregate mediaId"
                className="w-72 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
              />
              <button
                onClick={() => runMediaCanonicalization('dry-run', true)}
                disabled={canonicalBusy || !canonicalMediaId.trim()}
                className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
              >
                Dry-run
              </button>
              <button
                onClick={() => runMediaCanonicalization('repair', true)}
                disabled={canonicalBusy || !canonicalMediaId.trim()}
                className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
              >
                {canonicalBusy ? 'Running...' : 'Repair this title'}
              </button>
              {canonicalResult ? (
                <span className="min-w-0 flex-1 text-xs text-zinc-500">{canonicalResult}</span>
              ) : null}
            </div>
            <MetricCard
              label="Multiple TVDB IDs"
              value={stats.multiTvdbIdsActionable}
              sub={`${stats.multiTvdbIds.toLocaleString()} raw alias sets · ${stats.multiTvdbIdsAmbiguous.toLocaleString()} parked ambiguous`}
              hint={STAT_HINTS.multiTvdbIds}
              highlight={stats.multiTvdbIdsActionable > 0}
              action={
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => runTvdbIdRepair('dry-run')}
                    disabled={repairingTvdbIds}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runTvdbIdRepair('repair')}
                    disabled={repairingTvdbIds}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingTvdbIds ? 'Starting…' : 'Repair TVDB IDs'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Wrong-Kind External IDs"
              value={stats.wrongKindExternalIdMedia}
              sub={`${stats.wrongKindExternalIdAliases.toLocaleString()} aliases in the wrong movie/show namespace`}
              hint={STAT_HINTS.wrongKindExternalIds}
              highlight={stats.wrongKindExternalIdMedia > 0}
              action={
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => runWrongKindIdRepair('dry-run')}
                    disabled={repairingWrongKindIds}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runWrongKindIdRepair('repair')}
                    disabled={repairingWrongKindIds}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingWrongKindIds ? 'Starting…' : 'Repair Wrong-Kind IDs'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Movies Missing TMDB Identity"
              value={stats.providerDuplicateMovies}
              sub="TVDB/IMDb movie rows needing verified TMDB attachment or merge"
              hint={STAT_HINTS.providerDuplicateMovies}
              highlight={stats.providerDuplicateMovies > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={providerDuplicateCount}
                    onChange={(e) => setProviderDuplicateCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={() => runProviderDuplicateRepair('dry-run')}
                    disabled={repairingProviderDuplicates}
                    className="rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300"
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runProviderDuplicateRepair('repair')}
                    disabled={repairingProviderDuplicates}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingProviderDuplicates ? 'Starting…' : 'Repair Duplicates'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Non-English Base"
              value={stats.nonEnglishBase}
              sub="rows missing a trusted English base"
              hint={STAT_HINTS.nonEnglishBase}
              highlight={stats.nonEnglishBase > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={enBaseCount}
                    onChange={(e) => setEnBaseCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runEnBaseRepair}
                    disabled={repairingEnBase}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingEnBase ? 'Starting…' : 'Restore English Base'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Non-English Content (suspected)"
              value={stats.nonEnglishContent === null ? 'Not loaded' : stats.nonEnglishContent}
              sub={
                stats.nonEnglishContent === null
                  ? 'expensive scan skipped on page load'
                  : `${enContentDeep ? 'media + episode text' : 'media titles/overviews'} — most-visible first${(stats.nonEnglishContentParked ?? 0) > 0 ? ` · ${stats.nonEnglishContentParked?.toLocaleString()} parked 24h` : ''}`
              }
              hint={STAT_HINTS.nonEnglishContent}
              highlight={(stats.nonEnglishContent ?? 0) > 0}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {!enContentLoaded && !enContentDeep && (
                    <button
                      onClick={() => setEnContentStats(true)}
                      className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                    >
                      Load Count
                    </button>
                  )}
                  <input
                    type="number"
                    min={1}
                    value={enContentCount}
                    onChange={(e) => setEnContentCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={enContentDeep}
                      onChange={(e) => setEnContentDeep(e.target.checked)}
                    />
                    deep (all rows)
                  </label>
                  <button
                    onClick={runEnContentRepair}
                    disabled={repairingEnContent}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingEnContent ? 'Starting…' : 'Verify & Fix English'}
                  </button>
                  {enContentDeep && deepStats && (
                    <div className="basis-full rounded border border-rose-200 bg-white/70 p-2 text-xs text-zinc-600 dark:border-rose-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                      <div className="font-medium text-zinc-700 dark:text-zinc-200">
                        Deep backlog: {deepStats.unverified.toLocaleString()} unverified of{' '}
                        {deepStats.totalEligible.toLocaleString()} eligible rows
                      </div>
                      <div className="mt-1 text-zinc-500 dark:text-zinc-400">
                        Next run: {deepStats.remainingInPass.toLocaleString()} left in this pass ·
                        cursor {deepStats.cursorPosition.toLocaleString()}/
                        {deepStats.totalEligible.toLocaleString()} ({deepCursorPct}%)
                        {deepStats.cursorActive ? '' : ' · starts at beginning'}
                      </div>
                    </div>
                  )}
                </div>
              }
            />
            <MetricCard
              label="Banner as Poster"
              value={stats.bannerAsPoster}
              sub="wide banner or malformed TVDB poster URL"
              hint={STAT_HINTS.bannerAsPoster}
              highlight={stats.bannerAsPoster > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={bannerCount}
                    onChange={(e) => setBannerCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runBannerRepair}
                    disabled={repairingBanner}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingBanner ? 'Starting…' : 'Fix Banner Posters'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Rating Supplement Due"
              value={stats.missingRating}
              sub="missing or stale TMDB community rating"
              hint={STAT_HINTS.missingRating}
              highlight={stats.missingRating > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={ratingCount}
                    onChange={(e) => setRatingCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runRatingBackfill}
                    disabled={repairingRatings}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingRatings ? 'Starting…' : 'Backfill Ratings'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Missing Recommendations"
              value={stats.recommendationsMissing}
              sub="TMDB-linked rows with no recommendations snapshot"
              hint={STAT_HINTS.recommendationsMissing}
              highlight={stats.recommendationsMissing > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={recsCount}
                    onChange={(e) => setRecsCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runRecsBackfill}
                    disabled={repairingRecs}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingRecs ? 'Starting…' : 'Backfill Recommendations'}
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Movies Missing Country"
              value={stats.moviesMissingCountry}
              sub="TMDB-linked movie rows the country filter cannot match"
              hint={STAT_HINTS.moviesMissingCountry}
              highlight={stats.moviesMissingCountry > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={countriesCount}
                    onChange={(e) => setCountriesCount(e.target.value)}
                    className="w-20 rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800"
                    title="Rows per run"
                  />
                  <button
                    onClick={runCountriesBackfill}
                    disabled={repairingCountries}
                    className="rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                  >
                    {repairingCountries ? 'Starting…' : 'Backfill Countries'}
                  </button>
                </div>
              }
            />
          </div>

          {/* Classification breakdown */}
          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h2 className="mb-3 font-medium">Content Classification</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.byClassification).map(([key, count]) => {
                const meta = CLASSIFICATION_LABELS[key] ?? { label: key, color: 'default' };
                return (
                  <div key={key} className="flex items-center gap-2">
                    <Badge color={meta.color as any}>{meta.label}</Badge>
                    <span className="font-mono text-sm">{count}</span>
                    <span className="text-xs text-zinc-400">({pct(count)}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-zinc-400">
            Backfill uses the selected batch size and the persisted structural owner. General shows
            and all movies are TMDB-owned; strict anime shows are TVDB-owned only when TMDB has both
            Animation genre and the anime keyword; unresolved TVDB-only shows remain TVDB fallbacks.
            IMDb bridges identity only. Kitsu and Jikan enrich metadata but never classify or route
            structure. Provider refreshes cannot write non-owner seasons or episodes.
          </p>
        </>
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  hint,
  highlight,
  action,
}: {
  label: string;
  value: number | string;
  sub?: string;
  hint?: string;
  highlight?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : 'border-zinc-200 dark:border-zinc-700'}`}
    >
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
      {hint && (
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
