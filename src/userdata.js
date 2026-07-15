export const MAX_USER_DATA_BYTES = 2 * 1024 * 1024
export const MAX_USER_DATA_PATH_BYTES = 240

export async function userStorageNamespace(userId) {
  if (typeof userId !== 'string' || !userId) throw new Error('A user ID is required')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function decodeUserDataPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('A user data path is required')
  try {
    return validateUserDataPath(decodeURIComponent(value))
  } catch (error) {
    if (error instanceof URIError) throw new Error('The user data path is not valid URL encoding')
    throw error
  }
}

export function validateUserDataPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('A user data path is required')
  if (new TextEncoder().encode(value).byteLength > MAX_USER_DATA_PATH_BYTES) {
    throw new Error('The user data path is too long')
  }
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('The user data path is invalid')
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('The user data path is invalid')
  }
  return value
}

export function validateUserDataDirectory(value) {
  if (value === '') return ''
  const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value
  return `${validateUserDataPath(withoutSlash)}/`
}

export function relativeUserDataPath(path, directory, recurse = true) {
  if (!path.startsWith(directory)) return undefined
  const relative = path.slice(directory.length)
  if (!relative || (!recurse && relative.includes('/'))) return undefined
  return relative
}
