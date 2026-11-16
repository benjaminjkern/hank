// Split a markdown document into a leading preamble (text before the first
// `##` heading) + its level-2 sections. Each section keeps its `## heading`
// line in `raw`, so the pieces reassemble by concatenation — that's what makes
// a targeted single-section edit possible without a whole-file rewrite.
export function splitSections(md: string): {
  preamble: string;
  sections: { heading: string; raw: string }[];
} {
  const lines = md.split("\n");
  let preamble = "";
  const sections: { heading: string; lines: string[] }[] = [];
  let cur: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { heading: m[1].trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble += (preamble ? "\n" : "") + line;
    }
  }
  if (cur) sections.push(cur);
  return {
    preamble,
    sections: sections.map((s) => ({
      heading: s.heading,
      raw: s.lines.join("\n"),
    })),
  };
}
