/** Split a command line into words, honouring single quotes, double quotes and backslash escapes. No expansion. */
export function splitCommand(input: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1]!)) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} quote in command`);
  if (inWord) words.push(cur);
  return words;
}
