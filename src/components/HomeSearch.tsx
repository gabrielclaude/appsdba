'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CATEGORIES } from '@/lib/categories';

interface SearchResult {
  title: string;
  slug: string;
  category: string;
  isPremium: boolean;
}

export function HomeSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/posts/search?q=${encodeURIComponent(q)}`);
      const data: SearchResult[] = await res.json();
      setResults(data);
      setOpen(true);
      setSelected(-1);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = selected >= 0 ? results[selected] : results[0];
      if (target) {
        router.push(`/posts/${target.slug}`);
        setOpen(false);
        setQuery('');
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={containerRef} className="w-[70%] mx-auto mb-8">
      {/* Input row */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search posts…"
          className="w-full text-sm bg-[#0F1D38] text-white placeholder-[#FFCB8E]/50 border border-[#C8A84B]/50 rounded-lg px-4 py-2.5 focus:outline-none focus:border-[#E8693C] transition-colors"
          aria-label="Search posts"
          aria-autocomplete="list"
          aria-controls="home-search-results"
          aria-expanded={open}
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#FFCB8E]/60 text-xs">
            searching…
          </span>
        )}
        {query && !loading && (
          <button
            onClick={() => { setQuery(''); setOpen(false); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#FFCB8E]/50 hover:text-[#FFCB8E] transition-colors text-xs"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {/* Inline results box */}
      {open && results.length > 0 && (
        <ul
          id="home-search-results"
          role="listbox"
          className="mt-3 max-h-60 overflow-y-auto rounded-lg border border-[#C8A84B]/40 bg-[#0F1D38] shadow-xl shadow-black/40"
        >
          {results.map((r, i) => {
            const catLabel = CATEGORIES[r.category as keyof typeof CATEGORIES]?.label ?? r.category;
            return (
              <li key={r.slug} role="option" aria-selected={i === selected}>
                <Link
                  href={`/posts/${r.slug}`}
                  onClick={() => { setOpen(false); setQuery(''); }}
                  className={`flex items-start justify-between gap-3 px-4 py-3 border-b border-[#1E3566] last:border-0 transition-colors ${
                    i === selected ? 'bg-[#1A3260]' : 'hover:bg-[#1A3260]'
                  }`}
                >
                  <span className="flex-1 text-sm text-[#FFE4A0] leading-snug">{r.title}</span>
                  <div className="shrink-0 flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-[#FFCB8E]/60 whitespace-nowrap">{catLabel}</span>
                    {r.isPremium && (
                      <span className="text-[10px] text-amber-400 font-medium">PRO</span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {open && query.length >= 2 && !loading && results.length === 0 && (
        <div className="mt-3 rounded-lg border border-[#C8A84B]/40 bg-[#0F1D38] px-4 py-3 text-sm text-[#FFCB8E]/60">
          No posts found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}
