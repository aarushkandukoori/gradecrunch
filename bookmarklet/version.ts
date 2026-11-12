// The Sync bookmarklet's version. Bump it whenever the sync logic changes, so the app can tell
// students with an old bookmark to drag the new one. Lives in its own file because both the
// bookmarklet bundle and the app import it (and scripts/build-bookmarklet.mjs reads it).
export const BOOKMARKLET_VERSION = 1
