export interface DiffChunk {
  filePath: string;
  raw: string;
}

function extractFilePath(section: string): string {
  const match = section.match(/^\+\+\+ b\/(.+)$/m);
  if (match?.[1]) {
    return match[1].trim();
  }
  const header = section.match(/^diff --git a\/(.+) b\//m);
  return header?.[1]?.trim() ?? "unknown";
}

export function chunkDiff(rawDiff: string): DiffChunk[] {
  const sections = rawDiff.split(/^diff --git /m).filter((s) => s.trim().length > 0);
  return sections.map((section) => {
    const full = `diff --git ${section}`;
    return { filePath: extractFilePath(full), raw: full };
  });
}
