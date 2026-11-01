import { esc } from './core.js';

/** Small, safe Markdown renderer: everything is HTML-escaped first, then a few constructs are re-introduced. */
export function md(src) {
  const blocks = [];
  let text = String(src ?? '').replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  text = esc(text);
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    let m;
    if (/^\u0000\d+\u0000$/.test(t)) {
      flushPara();
      closeList();
      out.push(blocks[Number(t.slice(1, -1))]);
    } else if (!t) {
      flushPara();
      closeList();
    } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara();
      closeList();
      const n = m[1].length + 1;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      out.push('<hr>');
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') {
        closeList();
        // A list that resumes after a code block keeps its numbering.
        out.push(m[1] === '1' ? '<ol>' : `<ol start="${Number(m[1])}">`);
        list = 'ol';
      }
      out.push(`<li>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('\n');
}
