'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  lang: string;
  code: string;
}

export function CodeBlock({ lang, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for browsers without clipboard API
      const el = document.createElement('textarea');
      el.value = code;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="my-4">
      <div className="bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-t-md font-mono flex items-center justify-between">
        <span className="text-gray-400">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          title="Copy to clipboard"
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-all duration-150 text-xs font-sans
            ${copied
              ? 'text-green-400'
              : 'text-gray-400 hover:text-white hover:bg-gray-600'
            }`}
        >
          {copied ? (
            <>
              <Check size={12} strokeWidth={2.5} />
              Copied
            </>
          ) : (
            <>
              <Copy size={12} strokeWidth={2} />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="bg-gray-900 text-green-300 text-sm p-4 overflow-x-auto font-mono rounded-b-md">
        <code>{code}</code>
      </pre>
    </div>
  );
}
