import { diffLines, Change } from 'diff';

export enum ChangeType {
  NewFunction = 'NewFunction',
  ValueChange = 'ValueChange',
  Layout = 'Layout',
  Logic = 'Logic',
  Comment = 'Comment',
  Other = 'Other'
}

export interface DiffSummary {
  addedLines: string[];
  removedLines: string[];
  changeType: ChangeType;
  affectedRegion: string;
}

export class DiffAnalyzer {
  /**
   * Build a real line-based diff using the `diff` package (LCS).
   */
  private static extract(oldContent: string, newContent: string): { added: string[]; removed: string[] } {
    const changes: Change[] = diffLines(oldContent, newContent);
    const added: string[] = [];
    const removed: string[] = [];
    for (const c of changes) {
      if (c.added) {
        added.push(...c.value.split('\n').filter(l => l.length > 0));
      } else if (c.removed) {
        removed.push(...c.value.split('\n').filter(l => l.length > 0));
      }
    }
    return { added, removed };
  }

  /**
   * Returns true if the line is a pure comment line (language-independent heuristic).
   */
  private static isCommentLine(line: string): boolean {
    const t = line.trim();
    if (t.length === 0) { return false; }
    if (t.startsWith('//')) { return true; }
    if (t.startsWith('#')) { return true; }
    if (t.startsWith('/*') || t.startsWith('*/') || t.startsWith('*')) { return true; }
    if (t.startsWith('<!--') || t.startsWith('-->')) { return true; }
    return false;
  }

  /**
   * Returns true if ALL non-empty changed lines are comments.
   */
  private static onlyCommentChanges(added: string[], removed: string[]): boolean {
    const all = [...added, ...removed].filter(l => l.trim().length > 0);
    if (all.length === 0) { return false; }
    return all.every(l => this.isCommentLine(l));
  }

  static classify(oldContent: string, newContent: string): ChangeType {
    const { added, removed } = this.extract(oldContent, newContent);
    const all = [...added, ...removed];
    const joined = all.join('\n');

    if (all.length === 0) { return ChangeType.Other; }

    // Comment-only changes first (before layout/value/logic would match)
    if (this.onlyCommentChanges(added, removed)) {
      return ChangeType.Comment;
    }

    // Strip comments for further classification so value/logic detection
    // isn't fooled by a trailing "// something" on a line
    const stripComments = (s: string) =>
      s.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const meaningful = stripComments(joined);

    // New function/method detection
    const funcPattern = /(^|\s)(function\s+\w+|async\s+function\s+\w+|\w+\s*[:=]\s*(async\s+)?\([^)]*\)\s*=>|def\s+\w+|public\s+\w+\s+\w+\s*\(|private\s+\w+\s+\w+\s*\(|protected\s+\w+\s+\w+\s*\()/m;
    if (funcPattern.test(meaningful) && added.length > 2) {
      return ChangeType.NewFunction;
    }

    // Logic change (if/else/for/while/switch etc.)
    const logicPattern = /\b(if|else|for|while|switch|case|return|throw|catch|await|async)\b/;
    if (logicPattern.test(meaningful)) {
      return ChangeType.Logic;
    }

    // Value / parameter change
    const valuePattern = /[=<>!]=?\s*[\d"'`]|:\s*[\d"'`]|\b(true|false|null|undefined)\b/;
    if (valuePattern.test(meaningful) && added.length <= 5 && removed.length <= 5) {
      return ChangeType.ValueChange;
    }

    // Layout: pure whitespace / import-only / empty after stripping
    const layoutCandidate = meaningful
      .replace(/^\s*import\s.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (layoutCandidate.length === 0) {
      return ChangeType.Layout;
    }

    // CSS / HTML structural
    if (/^\s*[.#\w]+\s*\{|<\w+|style\s*=/m.test(meaningful)) {
      return ChangeType.Layout;
    }

    return ChangeType.Other;
  }

  static summarize(oldContent: string, newContent: string): DiffSummary {
    const { added, removed } = this.extract(oldContent, newContent);
    const changeType = this.classify(oldContent, newContent);

    // Find affected region (function/class name) in the new content
    let affectedRegion = 'unknown';
    const funcMatch = newContent.match(/function\s+(\w+)|(\w+)\s*[:=]\s*(async\s+)?\(|def\s+(\w+)|class\s+(\w+)/);
    if (funcMatch) {
      affectedRegion = funcMatch[1] || funcMatch[2] || funcMatch[4] || funcMatch[5] || 'unknown';
    }

    return {
      addedLines: added.slice(0, 20),
      removedLines: removed.slice(0, 20),
      changeType,
      affectedRegion
    };
  }

  static buildContext(filePath: string, summary: DiffSummary): string {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const parts: string[] = [];
    if (summary.addedLines.length > 0) {
      parts.push(`Added lines:\n${summary.addedLines.join('\n')}`);
    }
    if (summary.removedLines.length > 0) {
      parts.push(`Removed lines:\n${summary.removedLines.join('\n')}`);
    }
    return `File: ${fileName}\nRegion: ${summary.affectedRegion}\n${parts.join('\n\n')}`;
  }
}
