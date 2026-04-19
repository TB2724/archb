import { ActivityEntry } from './logManager';
import { OllamaClient } from './ollamaClient';

export interface Cluster {
  entryIds: string[];
  representative: ActivityEntry;
  changeType: string;
  filePaths: string[];
}

export class Clusterer {
  private ollama: OllamaClient;

  constructor(ollama: OllamaClient) {
    this.ollama = ollama;
  }

  /**
   * Cluster pending entries so the user gets ONE question per logical change
   * group, not one per individual raw edit. The pipeline is:
   *   1. Deterministic pre-grouping by (file + changeType) buckets.
   *      Also merge across files when the diffs share a strong signature
   *      (e.g. same variable renamed in multiple files).
   *   2. Optional Ollama refinement pass. If Ollama is down or invalid,
   *      the deterministic result is used as-is.
   */
  async clusterEntries(entries: ActivityEntry[]): Promise<Cluster[]> {
    if (entries.length === 0) { return []; }

    const deterministic = this.deterministicCluster(entries);
    if (deterministic.length <= 1) { return deterministic; }

    // Try Ollama for semantic merging of deterministic clusters
    try {
      const descriptions = deterministic.map(c => {
        const filesPart = c.filePaths.map(f => f.split(/[/\\]/).pop()).join(', ');
        const diff = c.representative.diff || '(no diff)';
        return `${c.changeType} in ${filesPart}:\n${diff.slice(0, 300)}`;
      });

      const groups = await this.ollama.clusterChanges(descriptions);
      if (!groups) { return deterministic; }

      // Merge deterministic clusters according to Ollama's grouping
      const merged: Cluster[] = [];
      for (const group of groups) {
        if (group.length === 0) { continue; }
        if (group.length === 1) {
          merged.push(deterministic[group[0]]);
          continue;
        }
        const parts = group.map(i => deterministic[i]);
        merged.push(this.mergeClusters(parts));
      }
      return merged;
    } catch {
      return deterministic;
    }
  }

  /**
   * Deterministic grouping. A cluster is formed by:
   *  - identical (file, changeType, signature) → same cluster
   *  - across files: same changeType + overlapping added/removed tokens → same cluster
   */
  private deterministicCluster(entries: ActivityEntry[]): Cluster[] {
    const buckets = new Map<string, ActivityEntry[]>();
    for (const e of entries) {
      const sig = this.signature(e);
      const key = `${e.file}|${e.changeType}|${sig}`;
      const arr = buckets.get(key) ?? [];
      arr.push(e);
      buckets.set(key, arr);
    }

    // Form initial clusters
    let clusters: Cluster[] = [];
    for (const arr of buckets.values()) {
      clusters.push({
        entryIds: arr.map(e => e.id),
        representative: this.pickRepresentative(arr),
        changeType: arr[0].changeType,
        filePaths: [...new Set(arr.map(e => e.file))]
      });
    }

    // Cross-file merge pass: same changeType + strong overlap in diff tokens
    const merged: Cluster[] = [];
    const used = new Set<number>();
    for (let i = 0; i < clusters.length; i++) {
      if (used.has(i)) { continue; }
      const group = [clusters[i]];
      used.add(i);
      const tokensI = this.tokens(clusters[i].representative.diff);
      for (let j = i + 1; j < clusters.length; j++) {
        if (used.has(j)) { continue; }
        if (clusters[j].changeType !== clusters[i].changeType) { continue; }
        const tokensJ = this.tokens(clusters[j].representative.diff);
        if (this.jaccard(tokensI, tokensJ) >= 0.5) {
          group.push(clusters[j]);
          used.add(j);
        }
      }
      merged.push(group.length === 1 ? group[0] : this.mergeClusters(group));
    }

    return merged;
  }

  private signature(e: ActivityEntry): string {
    // First ~8 non-empty words of the diff — stable within tiny edits
    const words = (e.diff || '').split(/\s+/).filter(w => w.length > 2).slice(0, 8);
    return words.join(' ').toLowerCase();
  }

  private tokens(diff: string): Set<string> {
    return new Set(
      (diff || '')
        .split(/[\s\W]+/)
        .map(t => t.toLowerCase())
        .filter(t => t.length > 2)
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) { return 0; }
    let inter = 0;
    for (const x of a) { if (b.has(x)) { inter++; } }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  private pickRepresentative(arr: ActivityEntry[]): ActivityEntry {
    // Most content changes → pick the longest diff
    return arr.slice().sort((a, b) => (b.diff?.length ?? 0) - (a.diff?.length ?? 0))[0];
  }

  private mergeClusters(parts: Cluster[]): Cluster {
    const entryIds = parts.flatMap(p => p.entryIds);
    const filePaths = [...new Set(parts.flatMap(p => p.filePaths))];
    const representative = parts
      .map(p => p.representative)
      .slice()
      .sort((a, b) => (b.diff?.length ?? 0) - (a.diff?.length ?? 0))[0];
    return {
      entryIds,
      representative,
      changeType: parts[0].changeType,
      filePaths
    };
  }
}
