interface PostContentProps {
  content: string;
}

export function PostContent({ content }: PostContentProps) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;

  const key = () => keyCounter++;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <div key={key()} className="my-4">
          {lang && (
            <div className="bg-gray-700 text-gray-300 text-xs px-3 py-1 rounded-t-md font-mono">
              {lang}
            </div>
          )}
          <pre className={`bg-gray-900 text-green-300 text-sm p-4 overflow-x-auto font-mono ${lang ? 'rounded-b-md' : 'rounded-md'}`}>
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={key()} className="text-xl font-bold text-gray-900 mt-8 mb-3 border-b pb-2">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={key()} className="text-lg font-semibold text-gray-800 mt-6 mb-2">
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={key()} className="list-disc list-inside space-y-1 my-3 text-gray-700">
          {items.map((item, idx) => (
            <li key={idx} dangerouslySetInnerHTML={{ __html: formatInline(item) }} />
          ))}
        </ul>
      );
      continue;
    } else if (line.trim() === '') {
      elements.push(<div key={key()} className="h-2" />);
    } else {
      elements.push(
        <p
          key={key()}
          className="text-gray-700 leading-relaxed my-2"
          dangerouslySetInnerHTML={{ __html: formatInline(line) }}
        />
      );
    }
    i++;
  }

  return <div className="prose-content">{elements}</div>;
}

function formatInline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="bg-gray-100 text-red-700 px-1 py-0.5 rounded text-sm font-mono">$1</code>');
}
