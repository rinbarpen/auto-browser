import { describe, expect, it } from 'vitest';
import {
  buildActionLabel,
  sanitizeTextPreview,
  summarizeObservation,
} from '../../extension/content-helpers.js';

describe('extension content helpers', () => {
  it('builds fallback labels for UI actions', () => {
    expect(buildActionLabel({ action: 'click_ref', ref: '@e1' })).toBe('Click @e1');
    expect(buildActionLabel({ action: 'click_point', x: 12.2, y: 40.7 })).toBe('Click (12, 41)');
    expect(buildActionLabel({ action: 'wait_for', text: 'Inbox' })).toBe('Wait for Inbox');
  });

  it('redacts fill values for the sidepanel and event stream', () => {
    expect(sanitizeTextPreview('secret-value')).toBe('se*********');
  });

  it('summarizes observations for status text', () => {
    expect(
      summarizeObservation({
        title: 'Inbox',
        url: 'https://mail.example.test',
        refs: [{ ref: '@e1' }],
        canvasRects: [{ x: 0, y: 0, width: 100, height: 50 }],
        visual: { reason: 'test' },
      })
    ).toBe('Inbox • 1 refs • 1 canvas • visual • https://mail.example.test');
  });
});
