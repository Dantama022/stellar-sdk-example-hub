/**
 * WebAssembly section-level diffing (ISSUE-239).
 *
 * A binary hash tells you *that* two Soroban contract artifacts differ, but
 * not *where*. This module compares two `.wasm` files at the level of the
 * WebAssembly section table and produces a structured report of what was
 * added, removed, modified or left untouched.
 *
 * The comparison is purely structural: sections are read from the binary and
 * hashed with SHA-256. Neither artifact is instantiated or executed.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { parseWasmSections, WasmParseError, type WasmSection } from './wasmBinary';

/** How a section changed between the two artifacts. */
export type SectionStatus = 'added' | 'removed' | 'modified' | 'unchanged';

/** A section of a single artifact. */
export interface SectionDescriptor {
  /** Stable key used to match sections between artifacts, e.g. `code:0`. */
  key: string;
  /** Numeric section id. */
  id: number;
  /** Canonical section name. */
  name: string;
  /** Occurrence index of the section among sections with the same name. */
  index: number;
  /** Custom-section name, when the section is a custom section. */
  customName?: string;
  /** Offset of the section inside the file. */
  offset: number;
  /** Payload size in bytes. */
  size: number;
  /** Number of bytes the section occupies, including its length prefix. */
  totalSize: number;
  /** SHA-256 of the section payload, hex encoded. */
  hash: string;
}

/** The result of comparing one section between the two artifacts. */
export interface SectionComparison {
  /** Stable key of the section. */
  key: string;
  /** Canonical section name. */
  section: string;
  /** Occurrence index of the section. */
  index: number;
  /** Custom-section name, when the section is a custom section. */
  customName?: string;
  /** How the section changed. */
  status: SectionStatus;
  /** Payload size in the old artifact. */
  oldSize?: number;
  /** Payload size in the new artifact. */
  newSize?: number;
  /** `newSize - oldSize`, when both are known. */
  sizeDelta?: number;
  /** Payload hash of the old artifact. */
  oldHash?: string;
  /** Payload hash of the new artifact. */
  newHash?: string;
  /** True when the payload bytes differ. */
  contentChanged: boolean;
  /** True when the payload size differs. */
  sizeChanged: boolean;
}

/** Summary counters of a diff. */
export interface SectionDiffSummary {
  /** Number of sections in the old artifact. */
  oldSectionCount: number;
  /** Number of sections in the new artifact. */
  newSectionCount: number;
  /** Number of sections that only exist in the new artifact. */
  added: number;
  /** Number of sections that only exist in the old artifact. */
  removed: number;
  /** Number of sections whose payload changed. */
  modified: number;
  /** Number of sections that are byte-for-byte identical. */
  unchanged: number;
  /** Total number of compared sections. */
  total: number;
  /** Total payload size of the old artifact. */
  oldPayloadSize: number;
  /** Total payload size of the new artifact. */
  newPayloadSize: number;
  /** Difference of the total payload size. */
  payloadSizeDelta: number;
  /** True when the two artifacts are byte-for-byte identical. */
  identical: boolean;
}

/** A complete section diff report. */
export interface SectionDiffReport {
  /** Path of the old artifact. */
  oldFile: string;
  /** Path of the new artifact. */
  newFile: string;
  /** SHA-256 of the whole old artifact. */
  oldFileHash: string;
  /** SHA-256 of the whole new artifact. */
  newFileHash: string;
  /** Section-level comparisons, ordered by section name and index. */
  sections: SectionComparison[];
  /** Summary counters. */
  summary: SectionDiffSummary;
}

/** Computes the SHA-256 of a buffer, hex encoded. */
export function hashBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Builds a stable key for a section.
 *
 * Standard sections are keyed by name and occurrence index. Custom sections
 * are keyed by their name so a custom section can be matched across
 * artifacts even when it moved to a different position.
 */
export function sectionKey(section: WasmSection): string {
  if (section.id === 0) {
    return `custom:${section.customName ?? 'unnamed'}#${section.index}`;
  }
  return `${section.name}:${section.index}`;
}

/** Describes every section of an artifact. */
export function describeSections(sections: WasmSection[]): SectionDescriptor[] {
  return sections.map((section) => ({
    key: sectionKey(section),
    id: section.id,
    name: section.name,
    index: section.index,
    customName: section.customName,
    offset: section.offset,
    size: section.size,
    totalSize: section.totalSize,
    hash: hashBytes(section.payload),
  }));
}

/**
 * Compares two lists of section descriptors.
 *
 * Sections are matched by their stable key. A section that exists in only
 * one artifact is reported as `added` or `removed`; a section that exists in
 * both is reported as `modified` when its payload hash differs and as
 * `unchanged` otherwise. Content changes are detected even when the payload
 * size stays the same.
 */
export function compareSectionLists(
  oldSections: SectionDescriptor[],
  newSections: SectionDescriptor[],
): SectionComparison[] {
  const oldByKey = new Map(oldSections.map((section) => [section.key, section]));
  const newByKey = new Map(newSections.map((section) => [section.key, section]));
  const keys = Array.from(new Set([...oldByKey.keys(), ...newByKey.keys()]));

  const comparisons: SectionComparison[] = [];

  for (const key of keys) {
    const oldSection = oldByKey.get(key);
    const newSection = newByKey.get(key);

    if (oldSection && !newSection) {
      comparisons.push({
        key,
        section: oldSection.name,
        index: oldSection.index,
        customName: oldSection.customName,
        status: 'removed',
        oldSize: oldSection.size,
        sizeDelta: -oldSection.size,
        oldHash: oldSection.hash,
        contentChanged: true,
        sizeChanged: true,
      });
      continue;
    }

    if (!oldSection && newSection) {
      comparisons.push({
        key,
        section: newSection.name,
        index: newSection.index,
        customName: newSection.customName,
        status: 'added',
        newSize: newSection.size,
        sizeDelta: newSection.size,
        newHash: newSection.hash,
        contentChanged: true,
        sizeChanged: true,
      });
      continue;
    }

    const oldEntry = oldSection as SectionDescriptor;
    const newEntry = newSection as SectionDescriptor;
    const contentChanged = oldEntry.hash !== newEntry.hash;
    const sizeChanged = oldEntry.size !== newEntry.size;

    comparisons.push({
      key,
      section: oldEntry.name,
      index: oldEntry.index,
      customName: oldEntry.customName,
      status: contentChanged ? 'modified' : 'unchanged',
      oldSize: oldEntry.size,
      newSize: newEntry.size,
      sizeDelta: newEntry.size - oldEntry.size,
      oldHash: oldEntry.hash,
      newHash: newEntry.hash,
      contentChanged,
      sizeChanged,
    });
  }

  comparisons.sort((a, b) => {
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    return a.index - b.index;
  });

  return comparisons;
}

/**
 * Compares two WebAssembly artifacts at the section level.
 *
 * @param oldPath path of the old artifact.
 * @param newPath path of the new artifact.
 * @throws {WasmParseError} when either file is not a valid WebAssembly module.
 */
export function diffWasmFiles(oldPath: string, newPath: string): SectionDiffReport {
  const oldBuffer = readFileSync(oldPath);
  const newBuffer = readFileSync(newPath);

  return diffWasmBuffers(oldBuffer, newBuffer, oldPath, newPath);
}

/** Compares two WebAssembly artifacts that are already in memory. */
export function diffWasmBuffers(
  oldBuffer: Buffer,
  newBuffer: Buffer,
  oldPath = 'old.wasm',
  newPath = 'new.wasm',
): SectionDiffReport {
  const oldSections = describeSections(parseWasmSections(oldBuffer));
  const newSections = describeSections(parseWasmSections(newBuffer));
  const comparisons = compareSectionLists(oldSections, newSections);

  const summary: SectionDiffSummary = {
    oldSectionCount: oldSections.length,
    newSectionCount: newSections.length,
    added: comparisons.filter((c) => c.status === 'added').length,
    removed: comparisons.filter((c) => c.status === 'removed').length,
    modified: comparisons.filter((c) => c.status === 'modified').length,
    unchanged: comparisons.filter((c) => c.status === 'unchanged').length,
    total: comparisons.length,
    oldPayloadSize: oldSections.reduce((sum, section) => sum + section.size, 0),
    newPayloadSize: newSections.reduce((sum, section) => sum + section.size, 0),
    payloadSizeDelta:
      newSections.reduce((sum, section) => sum + section.size, 0) -
      oldSections.reduce((sum, section) => sum + section.size, 0),
    identical: hashBytes(oldBuffer) === hashBytes(newBuffer),
  };

  return {
    oldFile: oldPath,
    newFile: newPath,
    oldFileHash: hashBytes(oldBuffer),
    newFileHash: hashBytes(newBuffer),
    sections: comparisons,
    summary,
  };
}

/** Formats a byte count for the console report. */
function formatBytes(value: number): string {
  return `${value} B`;
}

/**
 * Renders a human-readable report of a section diff.
 *
 * The report contains exactly the same information as the JSON output.
 */
export function formatSectionDiff(report: SectionDiffReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('WASM section diff');
  lines.push('===================');
  lines.push(`Old artifact: ${report.oldFile}`);
  lines.push(`New artifact: ${report.newFile}`);
  lines.push(`Old SHA-256: ${report.oldFileHash}`);
  lines.push(`New SHA-256: ${report.newFileHash}`);
  lines.push('');
  lines.push('Summary');
  lines.push('-------');
  lines.push(`Sections (old/new):  ${summary.oldSectionCount}/${summary.newSectionCount}`);
  lines.push(`Added:                 ${summary.added}`);
  lines.push(`Removed:               ${summary.removed}`);
  lines.push(`Modified:              ${summary.modified}`);
  lines.push(`Unchanged:             ${summary.unchanged}`);
  lines.push(`Payload size (old):    ${formatBytes(summary.oldPayloadSize)}`);
  lines.push(`Payload size (new):    ${formatBytes(summary.newPayloadSize)}`);
  lines.push(
    `Payload size delta:    ${summary.payloadSizeDelta >= 0 ? '+' : ''}${summary.payloadSizeDelta} B`,
  );
  lines.push(`Artifacts identical:   ${summary.identical ? 'yes' : 'no'}`);
  lines.push('');

  if (report.sections.length === 0) {
    lines.push('No sections found.');
    return lines.join('\n');
  }

  lines.push('Sections');
  lines.push('--------');
  for (const comparison of report.sections) {
    const label = comparison.customName
      ? `${comparison.section} (${comparison.customName})`
      : comparison.section;
    lines.push(`[${comparison.status.toUpperCase()}] ${label} — ${comparison.key}`);
    if (comparison.status === 'unchanged') {
      lines.push(`  size: ${comparison.oldSize} B (identical)`);
      lines.push(`  hash: ${comparison.oldHash}`);
      continue;
    }
    if (comparison.status === 'removed') {
      lines.push(`  size: ${comparison.oldSize} B (removed)`);
      lines.push(`  hash: ${comparison.oldHash}`);
      continue;
    }
    if (comparison.status === 'added') {
      lines.push(`  size: ${comparison.newSize} B (added)`);
      lines.push(`  hash: ${comparison.newHash}`);
      continue;
    }
    lines.push(`  old size: ${comparison.oldSize} B`);
    lines.push(`  new size: ${comparison.newSize} B`);
    lines.push(
      `  size delta: ${(comparison.sizeDelta ?? 0) >= 0 ? '+' : ''}${comparison.sizeDelta ?? 0} B`,
    );
    lines.push(`  content changed: ${comparison.contentChanged ? 'yes' : 'no'}`);
    lines.push(`  size changed: ${comparison.sizeChanged ? 'yes' : 'no'}`);
    lines.push(`  old hash: ${comparison.oldHash}`);
    lines.push(`  new hash: ${comparison.newHash}`);
  }

  return lines.join('\n');
}

/** Formats a diff as CSV, one row per section. */
export function sectionDiffToCsv(report: SectionDiffReport): string {
  const header = 'key,section,custom_name,status,old_size,new_size,size_delta,content_changed';
  const rows = report.sections.map((comparison) =>
    [
      comparison.key,
      comparison.section,
      comparison.customName ?? '',
      comparison.status,
      comparison.oldSize ?? '',
      comparison.newSize ?? '',
      comparison.sizeDelta ?? '',
      comparison.contentChanged,
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export { WasmParseError };
