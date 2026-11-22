/** Local-only capture storage shared by the service worker and viewer. */
const DATABASE = 'scrollframe-pdf';
const VERSION = 1;
let databasePromise;

function database() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('tiles')) {
          const tiles = db.createObjectStore('tiles', { keyPath: 'id' });
          tiles.createIndex('sessionId', 'sessionId');
          tiles.createIndex('sessionSection', ['sessionId', 'sectionId']);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        databasePromise = undefined;
        reject(request.error || new Error('Could not open local capture storage.'));
      };
      request.onblocked = () => {
        databasePromise = undefined;
        reject(new Error('Close older ScrollFrame tabs and try again.'));
      };
    });
  }
  return databasePromise;
}

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Local storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Local storage was interrupted.'));
  });
}

export async function putSession(session) {
  if (!session || !session.id) throw new Error('A capture ID is required.');
  const db = await database();
  const transaction = db.transaction('sessions', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('sessions').put(session);
  await done;
  return session;
}

export async function getSession(id) {
  const db = await database();
  return resultOf(db.transaction('sessions', 'readonly').objectStore('sessions').get(id));
}

export async function listSessions() {
  const db = await database();
  const sessions = await resultOf(db.transaction('sessions', 'readonly').objectStore('sessions').getAll());
  return sessions.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export async function putTile(tile) {
  if (!tile || !tile.id || !tile.sessionId || !tile.sectionId || !tile.blob) {
    throw new Error('The captured image is missing its storage information.');
  }
  const db = await database();
  const transaction = db.transaction('tiles', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('tiles').put(tile);
  await done;
  return tile;
}

export async function getTiles(sessionId, sectionId) {
  const db = await database();
  const store = db.transaction('tiles', 'readonly').objectStore('tiles');
  const request = sectionId === undefined
    ? store.index('sessionId').getAll(sessionId)
    : store.index('sessionSection').getAll([sessionId, sectionId]);
  const tiles = await resultOf(request);
  return tiles.sort((a, b) => Number(a.order || 0) - Number(b.order || 0)
    || Number(a.y || 0) - Number(b.y || 0) || Number(a.x || 0) - Number(b.x || 0));
}

export async function deleteSession(id) {
  const db = await database();
  const transaction = db.transaction(['sessions', 'tiles'], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('sessions').delete(id);
  const request = transaction.objectStore('tiles').index('sessionId').openCursor(IDBKeyRange.only(id));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await done;
}

export async function deleteAll() {
  const db = await database();
  const transaction = db.transaction(['sessions', 'tiles'], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('sessions').clear();
  transaction.objectStore('tiles').clear();
  await done;
}
