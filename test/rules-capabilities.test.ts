import { describe, expect, it } from 'vitest';
import { extensionKeyProblem } from '../src/rules/server.js';
import { byRule, scanFixture } from './helpers.js';

describe('capability rules', () => {
  const r = scanFixture('fixture-capabilities.json');

  it('warns on the deprecated logging capability', () => {
    const f = byRule(r, 'logging-capability-deprecated');
    expect(f[0]!.severity).toBe('warning');
    expect(f[0]!.pointer).toBe('/capabilities/logging');
  });

  it('flags tasks as a core capability', () => {
    expect(byRule(r, 'tasks-capability-moved')[0]!.pointer).toBe('/capabilities/tasks');
  });

  it('flags extension keys without a valid prefix and accepts io.modelcontextprotocol/tasks', () => {
    const f = byRule(r, 'extension-key-format');
    expect(f.map((x) => x.pointer).sort()).toEqual([
      '/capabilities/extensions/1com.example~1feature',
      '/capabilities/extensions/com.example~1-bad-',
      '/capabilities/extensions/tasks',
    ]);
  });

  it('notes listChanged and subscribe flags that now need subscriptions/listen', () => {
    expect(byRule(r, 'notifications-need-listen')[0]!.message).toBe('capabilities declare tools.listChanged, resources.subscribe');
  });

  it('reads capabilities from initialize in a legacy dump', () => {
    const pre = scanFixture('fixture-pre-revision.json');
    expect(byRule(pre, 'tasks-capability-moved')[0]!.pointer).toBe('/initialize/result/capabilities/tasks');
  });

  it('validates extension identifiers like _meta keys', () => {
    expect(extensionKeyProblem('com.example/feature')).toBeUndefined();
    expect(extensionKeyProblem('io.modelcontextprotocol/ui')).toBeUndefined();
    expect(extensionKeyProblem('com.example/')).toBeUndefined();
    expect(extensionKeyProblem('feature')).toContain('no prefix');
    expect(extensionKeyProblem('com.-x/feature')).toContain('prefix');
    expect(extensionKeyProblem('com.example/a b')).toContain('name');
  });
});
