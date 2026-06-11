import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverThreadId } from '../fetch-data.mjs';

test('discoverThreadId picks most common thread id', () => {
  const cases = [
    { reddit_url: 'https://www.reddit.com/r/f1visa/comments/1r6p9k0/comment/a/' },
    { reddit_url: 'https://www.reddit.com/r/f1visa/comments/1r6p9k0/comment/b/' },
    { reddit_url: 'https://www.reddit.com/r/f1visa/comments/zzz111/comment/c/' },
    { reddit_url: null },
  ];
  assert.equal(discoverThreadId(cases), '1r6p9k0');
  assert.equal(discoverThreadId([{ reddit_url: null }]), null);
});
