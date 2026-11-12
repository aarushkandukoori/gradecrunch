import { expect, test } from 'vitest'

test('environment has DOMParser and CompressionStream', () => {
  expect(typeof DOMParser).toBe('function')
  expect(typeof CompressionStream).toBe('function')
})
