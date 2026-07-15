import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeUserDataPath,
  relativeUserDataPath,
  userStorageNamespace,
  validateUserDataDirectory,
  validateUserDataPath
} from '../src/userdata.js'

test('creates stable isolated storage namespaces for users', async () => {
  const first = await userStorageNamespace('user-a')
  assert.equal(first, await userStorageNamespace('user-a'))
  assert.notEqual(first, await userStorageNamespace('user-b'))
  assert.match(first, /^[a-f0-9]{64}$/u)
})

test('accepts encoded workflow paths and Unicode filenames', () => {
  assert.equal(
    decodeUserDataPath(encodeURIComponent('workflows/測試.json')),
    'workflows/測試.json'
  )
  assert.equal(validateUserDataPath('workflows/folder/example.json'), 'workflows/folder/example.json')
})

test('rejects traversal, absolute paths, backslashes, NUL, and invalid encoding', () => {
  for (const path of [
    'workflows/../secret.json',
    '/workflows/test.json',
    'workflows\\test.json',
    'workflows//test.json',
    'workflows/./test.json',
    'workflows/test.json\0'
  ]) assert.throws(() => validateUserDataPath(path), /invalid/u)
  assert.throws(() => decodeUserDataPath('%E0%A4%A'), /URL encoding/u)
})

test('normalizes list directories and returns paths relative to them', () => {
  assert.equal(validateUserDataDirectory('workflows'), 'workflows/')
  assert.equal(validateUserDataDirectory('workflows/'), 'workflows/')
  assert.equal(relativeUserDataPath('workflows/測試.json', 'workflows/', true), '測試.json')
  assert.equal(relativeUserDataPath('workflows/folder/test.json', 'workflows/', false), undefined)
  assert.equal(relativeUserDataPath('other/test.json', 'workflows/', true), undefined)
})
