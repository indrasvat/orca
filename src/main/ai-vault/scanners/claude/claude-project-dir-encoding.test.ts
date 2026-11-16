import { expect, it } from 'vitest'
import { isClaudeProjectBucketFor } from './claude-project-dir-encoding'

it.each([
  { bucket: 'c--Users-me-wt', path: 'C:\\Users\\me\\wt', matches: true },
  { bucket: 'C--Users-me-wt', path: 'c:/users/me/wt/', matches: true },
  { bucket: '-Users-Me-wt', path: '/Users/me/wt', matches: false },
  { bucket: '-Users-me-wt', path: '/Users/me/wt', matches: true }
])('names $path bucket $bucket: $matches', ({ bucket, path, matches }) => {
  expect(isClaudeProjectBucketFor(bucket, path)).toBe(matches)
})
