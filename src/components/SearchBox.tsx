'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface SearchResult {
  title: string;
  slug: string;
  category: string;
  isPremium: boolean;
}

export function SearchBox() {
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
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search posts…"
          className="w-44 sm:w-56 text-sm bg-gray-800 text-white placeholder-gray-400 border border-gray-600 rounded px-3 py-1.5 focus:outline-none focus:border-orange-500 transition-colors"
          aria-label="Search posts"
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={open}
        />
        {loading && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">…</span>
        )}
      </div>

      {open && results.length > 0 && (
        <ul
          id="search-results"
          role="listbox"
          className="absolute right-0 mt-1 w-80 bg-gray-800 border border-gray-600 rounded shadow-xl z-50 max-h-80 overflow-y-auto"
        >
          {results.map((r, i) => (
            <li key={r.slug} role="option" aria-selected={i === selected}>
              <Link
                href={`/posts/${r.slug}`}
                onClick={() => { setOpen(false); setQuery(''); }}
                className={`flex items-start gap-2 px-3 py-2.5 hover:bg-gray-700 transition-colors border-b border-gray-700 last:border-0 ${i === selected ? 'bg-gray-700' : ''}`}
              >
                <span className="flex-1 text-sm text-white leading-snug">{r.title}</span>
                {r.isPremium && (
                  <span className="shrink-0 text-xs text-amber-400 font-medium mt-0.5">PRO</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {open && query.length >= 2 && !loading && results.length === 0 && (
        <div className="absolute right-0 mt-1 w-72 bg-gray-800 border border-gray-600 rounded shadow-xl z-50 px-4 py-3 text-sm text-gray-400">
          No posts found for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
}
