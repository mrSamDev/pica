// Minimal path-glob matcher for repo-file suppression (H2).
//
// Supported subset, anchored at the repo root, case-sensitive:
//   *   matches zero or more chars, never crossing a '/'
//   ?   matches exactly one char, never a '/'
//   **  a path segment that matches zero or more directories
//        - `**/` matches zero or more trailing-slash dirs
//        - trailing `/**` matches everything beneath (files + dirs)
//
// No brace expansion / character classes. Swap in minimatch only when a real
// rule needs them (none does today — manual ignores and the probe context use
// only `**` and `*`).

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

export function globMatchesPath(pattern: string, filePath: string): boolean {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      if (pattern.charAt(i + 1) === "*") {
        if (pattern.charAt(i + 2) === "/") {
          // `**/` = zero or more directories, each with a trailing slash.
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          // Trailing or mid-segment `**` = anything, crossing slashes.
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += escapeRegexChar(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`).test(filePath);
}
