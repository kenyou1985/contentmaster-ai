/**
 * 将「一整段无换行」的中文长文规范为可读段落（TTS/阅读）。
 * 用于备用模型等不输出换行时的后处理；已有正常分段时尽量保持原样。
 */
export function needsParagraphNormalization(text: string): boolean {
  if (!text || text.length < 400) return false;
  const nl = (text.match(/\n/g) || []).length;
  // 换行极少：视为「密文」
  if (nl < 3 && text.length > nl * 400) return true;
  const doubleNl = /\n\s*\n/.test(text);
  if (!doubleNl && text.length > 1200) return true;
  return false;
}

/**
 * 在句号、问号、叹号后插入换行；在「第N节课/堂课」前插入段前换行。
 */
export function normalizeDenseChineseParagraphs(text: string): string {
  if (!text) return text;
  let t = text.replace(/\r\n/g, '\n').trim();
  if (!needsParagraphNormalization(t)) {
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  // 课程标题独立成段（不要求行首；避免在行首/标点后重复加空行）
  t = t.replace(
    /(?<![\n。！？；])\s*(第\s*[一二三四五六七八九十0-9]+\s*(?:节课|堂课)[:：])/g,
    '\n\n$1'
  );

  const breakLongParagraphs = (s: string, maxLen: number): string =>
    s
      .split(/\n\n+/)
      .map((para) => {
        const p = para.trim();
        if (p.length <= maxLen) return p;
        let acc = '';
        let cur = '';
        for (const ch of p) {
          cur += ch;
          if (/[。！？]/.test(ch) && cur.length >= 140) {
            acc += `${cur.trim()}\n\n`;
            cur = '';
          }
        }
        return (acc + cur.trim()).trim();
      })
      .filter(Boolean)
      .join('\n\n');

  t = breakLongParagraphs(t, 380);

  return t.replace(/\n{3,}/g, '\n\n').trim();
}
