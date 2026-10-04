import { describe, expect, it } from 'vitest';
import { compareWithLock, counts, type Change } from '../src/surface/compare.js';
import { lockOf, surfaceOf } from './surface-helpers.js';

function diff(after: string, required: string[] = []): Change[] {
  return compareWithLock(lockOf('fixture-base.json', required), surfaceOf(after));
}

function brief(changes: Change[]): string[] {
  return changes.map((c) => `${c.severity} ${c.ruleId} ${c.subject}`);
}

describe('change classification', () => {
  it('finds nothing when nothing changed', () => {
    expect(diff('fixture-base.json')).toEqual([]);
  });

  it('a changed description is HIGH', () => {
    expect(brief(diff('fixture-description-changed.json'))).toEqual(['high tool-description-changed read_file']);
  });

  it('a changed input schema is HIGH', () => {
    expect(brief(diff('fixture-schema-changed.json'))).toEqual(['high tool-input-schema-changed write_file']);
  });

  it('added tools: destructive or unannotated is HIGH, read-only is MEDIUM', () => {
    const changes = diff('fixture-added-tools.json');
    expect(brief(changes)).toEqual(['high tool-added-unsafe delete_file', 'high tool-added-unsafe run_task', 'medium tool-added-readonly list_dir']);
    expect(changes[1]!.message).toContain('no annotations');
  });

  it('annotation downgrades are HIGH, with absent hints at their defaults', () => {
    const changes = diff('fixture-annotation-downgrade.json');
    expect(brief(changes)).toEqual(['high tool-annotation-downgrade search_files', 'high tool-annotation-downgrade write_file']);
    expect(changes[0]!.message).toContain('readOnlyHint true to false');
    expect(changes[0]!.message).toContain('not set, which defaults to true');
  });

  it('an annotation upgrade is MEDIUM, not a downgrade', () => {
    const lock = lockOf('fixture-annotation-downgrade.json');
    const changes = compareWithLock(lock, surfaceOf('fixture-base.json'));
    expect(brief(changes)).toEqual(['medium tool-annotation-changed search_files', 'medium tool-annotation-changed write_file']);
    expect(changes[0]!.message).toContain('readOnlyHint false to true');
  });

  it('a removed tool is LOW, or HIGH when the lock marks it required', () => {
    expect(brief(diff('fixture-removed-tool.json'))).toEqual(['low tool-removed search_files']);
    expect(brief(diff('fixture-removed-tool.json', ['search_files']))).toEqual(['high tool-removed-required search_files']);
  });

  it('reordering alone is one LOW change', () => {
    expect(brief(diff('fixture-reordered.json'))).toEqual(['low tool-order-changed tools']);
  });

  it('pagination: the same tools over three pages are unchanged', () => {
    expect(diff('fixture-pages.json')).toEqual([]);
  });

  it('classifies instructions, output schema, prompt, resource, title and version changes', () => {
    expect(brief(diff('fixture-other-changes.json'))).toEqual([
      'high server-instructions-changed server',
      'medium tool-output-schema-changed search_files',
      'medium prompt-changed prompt:summarise',
      'medium resource-changed resource:fixture://changelog',
      'low tool-title-changed read_file',
      'low server-version-changed server',
    ]);
  });

  it('counts by severity', () => {
    expect(counts(diff('fixture-added-tools.json'))).toEqual({ high: 2, medium: 1, low: 0 });
  });

  it('ignores parts a dump does not cover', () => {
    const lock = lockOf('fixture-pages.json');
    expect(lock.covers).toEqual(['tools']);
    expect(compareWithLock(lock, surfaceOf('fixture-other-changes.json')).map((c) => c.ruleId)).toEqual(['tool-output-schema-changed', 'tool-title-changed']);
  });
});
