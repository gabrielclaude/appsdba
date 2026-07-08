import { CodeBlock } from './CodeBlock';

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
        <CodeBlock key={key()} lang={lang} code={codeLines.join('\n')} />
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h2 key={key()} className="text-2xl font-bold text-[#0D1F3C] mt-10 mb-4 border-b border-[#C8A84B] pb-2">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={key()} className="text-xl font-semibold text-gray-800 mt-8 mb-3">
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
        <ul key={key()} className="list-disc list-inside space-y-2 my-4 text-gray-800 text-lg leading-relaxed">
          {items.map((item, idx) => (
            <li key={idx} dangerouslySetInnerHTML={{ __html: formatInline(item) }} />
          ))}
        </ul>
      );
      continue;
    } else if (line.trim() === '') {
      elements.push(<div key={key()} className="h-3" />);
    } else {
      elements.push(
        <p
          key={key()}
          className="text-gray-800 text-lg leading-[1.85] my-3"
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
    .replace(/`(.+?)`/g, '<code class="bg-[#f0e8d5] text-red-800 px-1.5 py-0.5 rounded text-base font-mono border border-[#d4c4a8]">$1</code>');
}
